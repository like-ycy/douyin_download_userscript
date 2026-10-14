// ==UserScript==
// @name         抖音画质探测与下载
// @namespace    douyin-quality-downloader
// @version      0.4.0
// @description  下载当前作品：视频画质探测、图集与苹果实况照片逐张、整组保存或打包为 ZIP。
// @author       like-ycy
// @license      MIT
// @homepageURL  https://github.com/like-ycy/douyin_download_userscript
// @supportURL   https://github.com/like-ycy/douyin_download_userscript/issues
// @icon         https://www.douyin.com/favicon.ico
// @match        https://www.douyin.com/*
// @run-at       document-start
// @sandbox      raw
// @noframes
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_info
// @grant        GM_registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      aweme.snssdk.com
// @connect      douyinvod.com
// @connect      bytecdn.cn
// @connect      ibytedtos.com
// @connect      byteimg.com
// @connect      douyinpic.com
// @license      MIT
// ==/UserScript==

(() => {
  'use strict';

  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  const MOBILE_UA = 'com.ss.android.ugc.aweme/220701 (Linux; U; Android 11; en_US; Pixel 5; Build/RQ3A; Cronet/58.0.0.0)';
  const RATIOS = ['default', '1080p', '2k', '4k', '720p', '540p', '360p'];
  const CDN_DOMAINS = ['douyinvod.com', 'bytecdn.cn', 'ibytedtos.com', 'byteimg.com', 'douyinpic.com'];
  const items = new Map();
  let activeId = '';
  let inspection = null;
  let inspectController = null;
  let pendingProbe = null;
  let currentPlayback = null;
  let notice = '';
  let download = null;
  let ui;
  let syncCurrent = () => {};

  // 仅接受已知媒体 CDN，不把页面中的任意地址交给扩展权限请求。
  function mediaUrl(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      return CDN_DOMAINS.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`)) ? url.href : '';
    } catch { return ''; }
  }

  function mediaKey(value) {
    const url = new URL(value);
    // 同一个 CDN 文件可有多个节点和临时签名；保留对象路径，不比较签名。
    const marker = url.pathname.indexOf('/video/tos/');
    return marker >= 0 ? url.pathname.slice(marker) : `${url.hostname}${url.pathname}`;
  }

  function workId(value) {
    return typeof value === 'string' && /^\d{10,25}$/.test(value) ? value : '';
  }

  function mediaUrls(list) {
    return Array.isArray(list) ? list.map(entry => mediaUrl(typeof entry === 'string' ? entry : entry?.src)).filter(Boolean) : [];
  }

  function normalizeVideo(video) {
    if (!video || typeof video !== 'object') return null;
    const address = (snake, camel, owner = video) => ({
      uri: snake?.uri || owner.uri, url_list: mediaUrls(snake?.url_list || camel),
      width: Number(snake?.width || owner.width) || 0, height: Number(snake?.height || owner.height) || 0,
    });
    const rates = Array.isArray(video.bit_rate) ? video.bit_rate : Array.isArray(video.bitRateList) ? video.bitRateList : [];
    const result = {
      play_addr: address(video.play_addr, video.playAddr),
      play_addr_h264: address(video.play_addr_h264, video.playAddrH264),
      play_addr_265: address(video.play_addr_265, video.playAddrH265),
      is_h265: video.is_h265 ?? video.isH265 ?? video.is_bytevc1,
      bit_rate: rates.filter(rate => rate && typeof rate === 'object').map(rate => ({ bit_rate: rate.bit_rate ?? rate.bitRate,
        is_h265: rate.is_h265 ?? rate.isH265 ?? rate.is_bytevc1,
        play_addr: address(rate.play_addr, rate.playAddr, rate) })),
    };
    const usable = typeof result.play_addr.uri === 'string' && result.play_addr.uri !== '' ||
      [result.play_addr, result.play_addr_h264, result.play_addr_265, ...result.bit_rate.map(rate => rate.play_addr)].some(value => value.url_list.length);
    return usable ? result : null;
  }

  function rememberItem(value) {
    const id = workId(value?.aweme_id) || workId(value?.awemeId);
    if (!id) return;
    // 详情 API 为 snake_case；推荐页 RSC / 卡片数据为 camelCase。
    const images = Array.isArray(value.images) ? value.images.map((image, index) => {
      const video = normalizeVideo(image?.video);
      return { index: index + 1, width: image?.width || 0, height: image?.height || 0,
        urls: mediaUrls(image?.url_list || image?.urlList), video,
        live: Boolean(video || Number(image?.live_photo_type ?? image?.livePhotoType) > 0),
      };
    }) : [];
    const album = images.length > 0 || Number(value.aweme_type ?? value.awemeType) === 68;
    // 图集顶层 video 可能是配乐；实况视频只从对应的 images[] 中读取。
    const normalizedVideo = album ? null : normalizeVideo(value.video);
    if (!album && (typeof normalizedVideo?.play_addr.uri !== 'string' || !normalizedVideo.play_addr.uri)) return;
    items.delete(id);
    items.set(id, {
      aweme_id: id, desc: value.desc || '', author: { nickname: value.author?.nickname || value.authorInfo?.nickname || '' },
      kind: album ? 'album' : 'video', images, video: normalizedVideo,
    });
    if (items.size > 100) {
      const discard = [...items.keys()].find(key => key !== activeId);
      if (discard) items.delete(discard);
    }
  }

  function acceptPayload(payload) {
    let count = 0;
    const visit = (value, depth) => {
      if (!value || typeof value !== 'object' || depth > 12 || ++count > 5000) return;
      if ((value.aweme_id || value.awemeId) && (value.video || Array.isArray(value.images) || Number(value.aweme_type ?? value.awemeType) === 68)) {
        rememberItem(value);
        return;
      }
      for (const child of Object.values(value)) visit(child, depth + 1);
    };
    visit(payload, 0);
    if (ui) syncCurrent();
  }

  function isVideoApi(value) {
    try {
      const url = new URL(value, location.href);
      return url.origin === location.origin && /^\/aweme\/v[12]\/web\//.test(url.pathname);
    } catch { return false; }
  }

  const embeddedScripts = new WeakMap();
  let rscBuffer = new Uint8Array();
  let rscSkipBytes = 0;
  function readRscChunk(text) {
    // Flight 同时有换行记录和 T<十六进制字节数>,<正文> 记录；正文后没有换行。
    // 必须按 UTF-8 字节长度跨 script 跳过文本/二进制块，不能把下一条 JSON 拼入正文。
    const bytes = new TextEncoder().encode(text);
    const buffer = new Uint8Array(rscBuffer.length + bytes.length);
    buffer.set(rscBuffer); buffer.set(bytes, rscBuffer.length);
    const decoder = new TextDecoder();
    let offset = 0;
    while (offset < buffer.length) {
      if (rscSkipBytes) {
        const take = Math.min(rscSkipBytes, buffer.length - offset);
        offset += take; rscSkipBytes -= take;
        continue;
      }
      const colon = buffer.indexOf(58, offset);
      if (colon < 0 || colon + 1 >= buffer.length) break;
      if (!/^[\da-f]+$/i.test(decoder.decode(buffer.subarray(offset, colon)))) {
        // 损坏的记录不能猜边界，更不能扫描正文中的伪造作品数据。
        offset = buffer.length;
        break;
      }
      const start = colon + 1;
      if ('TAOoUSsLlGgMmV'.includes(String.fromCharCode(buffer[start]))) {
        const comma = buffer.indexOf(44, start + 1);
        if (comma < 0) break;
        const lengthText = decoder.decode(buffer.subarray(start + 1, comma));
        const length = /^[\da-f]+$/i.test(lengthText) ? parseInt(lengthText, 16) : NaN;
        if (!Number.isSafeInteger(length)) { offset = buffer.length; break; }
        rscSkipBytes = length; offset = comma + 1;
      } else {
        const newline = buffer.indexOf(10, start);
        if (newline < 0) break;
        if (buffer[start] === 91 || buffer[start] === 123) {
          try { acceptPayload(JSON.parse(decoder.decode(buffer.subarray(start, newline)))); }
          catch { /* 非 JSON 引用行不会作为作品数据使用 */ }
        }
        offset = newline + 1;
      }
    }
    rscBuffer = buffer.slice(offset);
    if (rscBuffer.length > 2 * 1024 * 1024) rscBuffer = new Uint8Array();
  }

  function readEmbeddedScript(script) {
    const text = script.textContent || '';
    if (!text || embeddedScripts.get(script) === text) return;
    embeddedScripts.set(script, text);
    const match = text.match(/^\s*self\.__pace_f\.push\((\[[\s\S]*\])\);?\s*$/);
    if (!match) return;
    let chunk;
    try { chunk = JSON.parse(match[1]); } catch { return; }
    if (chunk[0] !== 1 || typeof chunk[1] !== 'string') return;
    readRscChunk(chunk[1]);
  }

  function captureEmbeddedData() {
    for (const script of document.scripts) readEmbeddedScript(script);
    const observer = new MutationObserver(records => {
      for (const record of records) {
        const target = record.target.nodeType === 3 ? record.target.parentElement : record.target;
        if (target?.tagName === 'SCRIPT') readEmbeddedScript(target);
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === 'SCRIPT') readEmbeddedScript(node);
          else for (const script of node.querySelectorAll('script')) readEmbeddedScript(script);
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  // 页面负责登录、签名和请求；只读取副本，保留原响应和原函数行为。
  const originalFetch = page.fetch;
  page.fetch = function (...args) {
    const result = Reflect.apply(originalFetch, this, args);
    const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0]);
    if (isVideoApi(url)) {
      result.then(response => {
        if (response.ok) response.clone().json().then(acceptPayload).catch(() => {});
      }).catch(() => {});
    }
    return result;
  };
  const originalOpen = page.XMLHttpRequest.prototype.open;
  const watchedXhrs = new WeakSet();
  page.XMLHttpRequest.prototype.open = function (...args) {
    if (!watchedXhrs.has(this)) {
      watchedXhrs.add(this);
      this.addEventListener('load', () => {
        try {
          if (this.status !== 200 || !isVideoApi(this.responseURL)) return;
          if (this.responseType === 'json') acceptPayload(this.response);
          else if (!this.responseType || this.responseType === 'text') acceptPayload(JSON.parse(this.responseText));
        } catch { /* 不干扰抖音页面的请求 */ }
      });
    }
    return Reflect.apply(originalOpen, this, args);
  };

  function currentWork() {
    const visible = elements => [...elements].map(element => {
      const style = page.getComputedStyle?.(element);
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return null;
      const box = element.getBoundingClientRect();
      const width = Math.max(0, Math.min(innerWidth, box.right) - Math.max(0, box.left));
      const height = Math.max(0, Math.min(innerHeight, box.bottom) - Math.max(0, box.top));
      const area = width * height;
      const video = element.tagName === 'VIDEO' ? element : element.querySelector('video');
      const activeCard = Boolean(element.closest('[data-e2e="feed-active-video"]'));
      return { element, video, box, area, activeCard, score: area * (video && !video.paused ? 2 : 1) };
    }).filter(entry => entry && entry.area > 10000)
      .sort((a, b) => Number(b.activeCard) - Number(a.activeCard) || b.score - a.score);
    // 图集的 video 只播放配乐，尺寸为零；以作品卡片定位，不依赖播放器画面。
    const cards = [...document.querySelectorAll('[data-e2e-vid]')];
    const videos = [...document.querySelectorAll('video')].filter(video => !video.closest('[data-e2e-vid]'));
    return visible([...cards, ...videos])[0] || null;
  }

  function idFromLink(value) {
    try {
      const url = new URL(value, location.href);
      if (url.hostname !== 'www.douyin.com' && url.hostname !== 'douyin.com') return '';
      return workId(url.searchParams.get('modal_id')) || workId(url.searchParams.get('aweme_id')) ||
        workId(url.pathname.match(/\/(?:video|note)\/(\d+)(?:\/|$)/)?.[1]);
    } catch { return ''; }
  }

  // 推荐/关注页把正在看的作品标记在 feed-active-video[data-e2e-vid] 上。
  function cardIdentity(video) {
    for (let element = video; element && element !== document.body && element !== document.documentElement; element = element.parentElement) {
      if (element !== video && element.querySelectorAll('video').length > 1) break;
      for (const attr of ['data-e2e-vid', 'data-aweme-id', 'data-awemeid', 'data-video-id', 'data-item-id']) {
        const id = workId(element.getAttribute?.(attr));
        if (id) return id;
      }
      const ids = new Set();
      for (const link of element.querySelectorAll('a[href]')) {
        const id = idFromLink(link.getAttribute('href'));
        if (id) ids.add(id);
      }
      if (ids.size === 1) return [...ids][0];
    }
    return '';
  }

  function currentId(active = currentWork()) {
    if (active) {
      const { video } = active;
      const cardId = cardIdentity(active.element);
      if (cardId) return cardId;
      for (const src of video ? [video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map(source => source.src)] : []) {
        if (!src) continue;
        try {
          const id = workId(new URL(src).searchParams.get('__vid'));
          if (id) return id;
          const safe = mediaUrl(src);
          if (!safe) continue;
          const key = mediaKey(safe);
          for (const item of items.values()) {
            if (!item.video) continue;
            const addresses = [item.video.play_addr, item.video.play_addr_h264, item.video.play_addr_265,
              ...(item.video.bit_rate || []).map(rate => rate.play_addr)];
            if (addresses.some(address => (address?.url_list || []).some(value => mediaUrl(value) && mediaKey(value) === key))) return item.aweme_id;
          }
        } catch { /* blob 地址没有作品 ID，继续检查 source */ }
      }
    }
    // 完整视频链接仍支持，但播放器/卡片证据优先于可能滞后的地址栏。
    return idFromLink(location.href);
  }

  function playbackChanged(before, after) {
    if (!before || !after) return before !== after;
    return before.element !== after.element ||
      Boolean(before.source && after.source && before.source !== after.source) ||
      Boolean(before.id && after.id && before.id !== after.id);
  }

  function readCurrentItem(element, id) {
    // 仅在点击时读取当前卡片的组件属性，补上脚本启动前已经加载的作品。
    // 不遍历全站状态；祖先深度和作品 ID 都严格限定。
    if (!element || !id) return;
    try {
      const key = Object.keys(element).find(name => name.startsWith('__reactFiber$'));
      for (let fiber = element[key], depth = 0; fiber && depth < 20; fiber = fiber.return, depth++) {
        for (const value of [fiber.memoizedProps?.item, fiber.memoizedProps?.slideData]) {
          if ((workId(value?.aweme_id) || workId(value?.awemeId)) !== id) continue;
          rememberItem(value);
          if (items.has(id)) return;
        }
      }
    } catch { /* 组件数据不可用时仍由页面内嵌数据和网络响应提供作品 */ }
  }

  function beginCurrentProbe() {
    syncCurrent();
    if (inspection?.busy && inspection.id === activeId) { ui.panel.hidden = false; return; }
    notice = '';
    ui.panel.hidden = false;
    readCurrentItem(currentPlayback?.element, activeId);
    pendingProbe = currentPlayback ? { ...currentPlayback, deadline: Date.now() + 10000 } : null;
    if (!pendingProbe) notice = '没有找到当前作品，请先打开要下载的视频或图集。';
    syncCurrent();
    render();
  }

  function header(response, name) {
    return String(response.responseHeaders || '').split(/\r?\n/)
      .find(line => line.slice(0, line.indexOf(':')).toLowerCase() === name.toLowerCase())
      ?.slice(name.length + 1).trim() || '';
  }

  function abortError() { return new DOMException('操作已取消', 'AbortError'); }

  function request(url, { method = 'GET', range, signal } = {}) {
    if (!mediaUrl(url) && !url.startsWith('https://aweme.snssdk.com/aweme/v1/play/?')) {
      return Promise.reject(new Error('该地址不属于允许的媒体域名'));
    }
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(abortError()); return; }
      let task;
      let settled = false;
      const finish = (error, response) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(response);
      };
      const cancel = () => { finish(abortError()); task?.abort(); };
      signal?.addEventListener('abort', cancel, { once: true });
      const rangeBounds = range?.match(/^bytes=(\d+)-(\d+)$/);
      // 播放接口也可能返回少量 JSON，允许至多 256 KiB；禁止无界读取。
      const maxBytes = Math.max(262144, rangeBounds ? Number(rangeBounds[2]) - Number(rangeBounds[1]) + 1 : 0);
      try {
        task = GM_xmlhttpRequest({
          method, url, timeout: 20000, responseType: 'arraybuffer',
          headers: { 'User-Agent': MOBILE_UA, Referer: 'https://www.douyin.com/', ...(range ? { Range: range } : {}) },
          onload: response => finish(null, response),
          // 服务端忽略 Range 时立即中止，避免为探测把整段视频拉到内存。
          onreadystatechange: response => {
            if (range && response.readyState === 2 && response.status === 200 && /^video\//i.test(header(response, 'content-type'))) {
              finish(new Error('视频服务器忽略了 Range 请求，已停止读取'));
              task?.abort();
            }
          },
          onerror: () => finish(new Error('网络请求失败，请检查油猴的跨域授权')),
          onprogress: response => {
            if (range && response.loaded > maxBytes) {
              finish(new Error('视频服务器未按范围返回数据，已停止读取'));
              task?.abort();
            }
          },
          ontimeout: () => finish(new Error('媒体请求超时')),
          onabort: () => finish(abortError()),
        });
      } catch (error) { finish(error); }
    });
  }

  function responseSize(response) {
    const range = header(response, 'content-range').match(/^bytes\s+\d+-\d+\/(\d+)$/i);
    const value = range?.[1] || (response.status === 200 ? header(response, 'content-length') : '');
    const size = Number(value);
    return Number.isSafeInteger(size) && size > 0 ? size : null;
  }

  async function measure(url, signal) {
    const response = await request(url, { range: 'bytes=0-0', signal });
    if (![200, 206].includes(response.status)) throw new Error(`视频服务器返回 HTTP ${response.status}`);
    const type = header(response, 'content-type');
    if (/text\/|json/i.test(type)) throw new Error('视频地址返回了网页或错误信息');
    const final = mediaUrl(response.finalUrl || url);
    if (!final) throw new Error('播放接口没有返回视频直链');
    return { url: final, size: responseSize(response) };
  }

  async function probe(uri, ratio, signal) {
    const endpoint = `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(uri)}&ratio=${ratio}&line=0&aid=6383`;
    // GM 默认跟随 302；Range 同时限制最终视频正文，只读取一字节。
    const response = await request(endpoint, { range: 'bytes=0-0', signal });
    const direct = mediaUrl(response.finalUrl);
    if (direct && [200, 206].includes(response.status) && !/text\/|json/i.test(header(response, 'content-type'))) {
      return { url: direct, size: responseSize(response) };
    }
    if (response.status === 200) {
      let data;
      try {
        data = JSON.parse(new TextDecoder().decode(response.response));
      } catch { /* 非 JSON 或无视频直链 */ }
      if (data?.status_code === 0) {
        const url = (data.play_addr?.url_list || []).map(mediaUrl).find(Boolean);
        if (url) return measure(url, signal);
      }
    }
    throw new Error(`播放接口 ${ratio} 未返回视频（HTTP ${response.status}）`);
  }

  // MP4 的 tkhd 给出实际画面尺寸；只读少量文件头/索引，不按请求 ratio 猜尺寸。
  function mp4Info(buffer) {
    const view = new DataView(buffer);
    const text = offset => String.fromCharCode(...new Uint8Array(buffer, offset, 4));
    let best = null;
    let nextOffset = null;
    const scan = (start, end, depth) => {
      for (let offset = start; offset + 8 <= end;) {
        const type = text(offset + 4);
        let size = view.getUint32(offset);
        let head = 8;
        if (size === 1) {
          if (offset + 16 > end) break;
          size = Number(view.getBigUint64(offset + 8)); head = 16;
        }
        if (size === 0) size = end - offset;
        if (!Number.isSafeInteger(size) || size < head) break;
        if (offset + size > end) {
          if (depth === 0 && type === 'mdat') nextOffset = offset + size;
          else if (['moov', 'trak'].includes(type) && depth < 3) scan(offset + head, end, depth + 1);
          break;
        }
        if (type === 'tkhd' && size >= head + 84) {
          let width = Math.round(view.getUint32(offset + size - 8) / 65536);
          let height = Math.round(view.getUint32(offset + size - 4) / 65536);
          const matrix = offset + size - 44;
          if (view.getInt32(matrix) === 0 && view.getInt32(matrix + 16) === 0 && view.getInt32(matrix + 4) !== 0) [width, height] = [height, width];
          if (width > 0 && height > 0 && (!best || width * height > best.width * best.height)) best = { width, height };
        } else if (['moov', 'trak'].includes(type) && depth < 3) scan(offset + head, offset + size, depth + 1);
        offset += size;
      }
    };
    scan(0, buffer.byteLength, 0);
    return { dimensions: best, nextOffset };
  }

  async function dimensions(url, size, signal) {
    const response = await request(url, { range: 'bytes=0-262143', signal });
    if (response.status !== 206 || !(response.response instanceof ArrayBuffer)) return null;
    const info = mp4Info(response.response);
    if (info.dimensions) return info.dimensions;
    if (info.nextOffset && size && info.nextOffset < size) {
      const tail = await request(url, { range: `bytes=${info.nextOffset}-${Math.min(size - 1, info.nextOffset + 262143)}`, signal });
      if (tail.status === 206) return mp4Info(tail.response).dimensions;
    }
    return null;
  }

  function pageQualities(item) {
    const rates = [
      { play_addr: item.video.play_addr, is_h265: item.video.is_h265 },
      { play_addr: item.video.play_addr_h264, is_h265: false },
      { play_addr: item.video.play_addr_265, is_h265: true },
      ...(item.video.bit_rate || []),
    ];
    return rates.flatMap(rate => {
      const address = rate.play_addr;
      const url = (address?.url_list || []).map(mediaUrl).find(Boolean);
      if (!url) return [];
      const h265 = Boolean(rate.is_h265 || rate.is_bytevc1);
      return [{ url, label: '网页画质', width: Number(address.width) || 0, height: Number(address.height) || 0,
        codec: h265 ? 'H.265' : 'H.264', bitrate: Number(rate.bit_rate) || 0, ratio: null }];
    });
  }

  function imageExtension(type) {
    const extensions = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif' };
    const mime = (type || '').split(';')[0].trim().toLowerCase();
    return Object.hasOwn(extensions, mime) ? extensions[mime] : '';
  }

  async function measureImage(url, signal) {
    // 图片 CDN 可能忽略 Range；HEAD 只取头，不为探测下载整张图片。
    const response = await request(url, { method: 'HEAD', signal });
    if (response.status !== 200) throw new Error(`图片服务器返回 HTTP ${response.status}`);
    const extension = imageExtension(header(response, 'content-type'));
    if (!extension) throw new Error('图片地址未返回支持的图片格式');
    const final = mediaUrl(response.finalUrl || url);
    if (!final) throw new Error('图片地址不属于允许的媒体域名');
    return { url: final, size: responseSize(response), extension };
  }

  async function inspectAlbum(item, state, signal) {
    for (const image of item.images) {
      if (signal.aborted) break;
      let result;
      let errorMessage = '没有可用的图片地址';
      // 优先 JPEG，保持页面提供的完整签名；失败才尝试同张图片的其他节点/格式。
      const urls = [...new Set(image.urls)].sort((a, b) =>
        Number(/\.jpe?g$/i.test(new URL(b).pathname)) - Number(/\.jpe?g$/i.test(new URL(a).pathname)));
      for (const url of urls) {
        try { result = await measureImage(url, signal); break; }
        catch (error) {
          if (error.name === 'AbortError') return;
          errorMessage = error.message;
        }
      }
      if (!result) { state.errors.push(`图片 ${image.index}：${errorMessage}`); render(); continue; }
      const photo = { ...result, kind: 'image', index: image.index,
        label: `图片 ${image.index}`, width: image.width, height: image.height };
      if (image.live) {
        let video;
        errorMessage = '页面尚未提供实况视频地址';
        // 保留该图的视频候选节点，不能误用图集顶层的配乐或其他图片的视频。
        for (const candidate of image.video ? pageQualities({ video: image.video }) : []) {
          try { video = { ...candidate, ...await measure(candidate.url, signal) }; break; }
          catch (error) {
            if (error.name === 'AbortError') return;
            errorMessage = error.message;
          }
        }
        if (signal.aborted) return;
        if (video) state.rows.push({ kind: 'live', index: image.index, label: `实况 ${image.index}`, photo, video,
          width: video.width, height: video.height, size: photo.size && video.size ? photo.size + video.size : null });
        else {
          // 明确标出缺失的动态部分，静态照片仍可单独保存。
          state.rows.push({ ...photo, label: `图片 ${image.index} · 仅静态` });
          state.errors.push(`实况 ${image.index}：${errorMessage}；本次仅提供静态图，请刷新后重试。`);
        }
      } else state.rows.push(photo);
      render();
    }
    if (!item.images.length) state.errors.push('当前图集尚未提供图片列表，请重新打开下载面板。');
  }

  async function inspect(item) {
    inspectController?.abort();
    const controller = new AbortController();
    inspectController = controller;
    const state = { id: item.aweme_id, item, rows: [], errors: [], busy: true };
    inspection = state;
    render();
    if (item.kind === 'album') {
      await inspectAlbum(item, state, controller.signal);
      state.busy = false;
      if (inspectController === controller) inspectController = null;
      render();
      return;
    }
    const seen = new Map();
    // default 必须先尝试；网页的转码档位可在移动接口失败时继续使用。
    const candidates = [...RATIOS.map(ratio => ({ ratio, label: ratio === 'default' ? 'default · 原始播放档' : ratio })), ...pageQualities(item)];
    for (const candidate of candidates) {
      if (controller.signal.aborted) break;
      try {
        const result = candidate.ratio ? await probe(item.video.play_addr.uri, candidate.ratio, controller.signal) : await measure(candidate.url, controller.signal);
        const key = mediaKey(result.url);
        if (seen.has(key)) {
          const existing = seen.get(key);
          if (!existing.codec && candidate.codec) existing.codec = candidate.codec;
          if (!existing.bitrate && candidate.bitrate) existing.bitrate = candidate.bitrate;
          render();
          continue;
        }
        let actual = null;
        try { actual = await dimensions(result.url, result.size, controller.signal); }
        catch (error) { if (error.name === 'AbortError') throw error; }
        const row = { ...candidate, ...result, width: actual?.width || candidate.width || 0, height: actual?.height || candidate.height || 0 };
        // 没有测到实际尺寸时明确显示未知；接口接受的 ratio 仅是请求参数。
        if (candidate.ratio && candidate.ratio !== 'default') row.label = '播放档';
        seen.set(key, row);
        state.rows.push(row);
        render();
      } catch (error) {
        if (error.name === 'AbortError') break;
        state.errors.push(`${candidate.label}：${error.message}`);
      }
    }
    state.rows.sort((a, b) => Number(b.ratio === 'default') - Number(a.ratio === 'default') || b.width * b.height - a.width * a.height || (b.size || 0) - (a.size || 0));
    state.busy = false;
    if (inspectController === controller) inspectController = null;
    render();
  }

  function humanSize(size) {
    if (!size) return '大小未知';
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let index = 0;
    while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
    return `${size.toFixed(index ? 2 : 0)} ${units[index]}`;
  }

  function cleanFilenamePart(value) {
    return String(value || '').normalize('NFC')
      .replace(/[\\/:*?"<>|\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]|\p{Surrogate}/gu, ' ')
      .replace(/\s+/g, ' ').trim().replace(/^[ ._-]+|[ ._-]+$/g, '');
  }

  function clipFilename(value, maxUnits, maxBytes) {
    const encoder = new TextEncoder();
    let result = '';
    let bytes = 0;
    // 按完整字素裁剪，避免截断 emoji、组合字符或 UTF-16 代理对。
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)) {
      const size = encoder.encode(segment).length;
      if (result.length + segment.length > maxUnits || bytes + size > maxBytes) break;
      result += segment; bytes += size;
    }
    return result.replace(/[ .]+$/g, '');
  }

  function baseName(item, fallback) {
    const author = clipFilename(cleanFilenamePart(item.author?.nickname), 20, 60);
    const title = cleanFilenamePart((item.desc || '').replace(/#[^\s#]+/g, '').replace(/#/g, ''));
    let base = author && title ? `${author} - ${title}` : title || fallback;
    // Windows 设备名带扩展名也保留；清洗后再次保证不会成为设备名。
    if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(base)) base = `_${base}`;
    return base;
  }

  function filename(item, row) {
    const validDimension = value => Number.isSafeInteger(value) && value > 0 && value <= 65535;
    const quality = row.ratio === 'default' ? 'default'
      : validDimension(row.width) && validDimension(row.height) ? `${row.width}x${row.height}` : '未知尺寸';
    const codec = clipFilename(cleanFilenamePart(row.codec), 16, 32);
    const suffix = row.kind === 'live' ? ` - 实况${String(row.index).padStart(3, '0')}.${row.extension || 'zip'}`
      : row.kind === 'image'
      ? ` - 图片${String(row.index).padStart(3, '0')}.${row.extension}`
      : ` - ${quality}${codec ? ` ${codec}` : ''}.mp4`;
    // 整个文件名（含画质后缀和扩展名）同时限制 UTF-16 长度与 UTF-8 字节数。
    const budget = 200 - new TextEncoder().encode(suffix).length;
    const base = clipFilename(baseName(item, `douyin_${workId(item.aweme_id) || 'video'}`), 120 - suffix.length, budget) || 'douyin_video';
    return base + suffix;
  }

  function zipName(item) {
    const base = clipFilename(baseName(item, `douyin_${workId(item.aweme_id) || 'album'}`), 120, 190) || 'douyin_images';
    return `${base}.zip`;
  }

  function saveDownload(item, row, resolved, state) {
    return new Promise((resolve, reject) => {
      const signal = state.controller.signal;
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        error ? reject(error) : resolve();
      };
      const cancel = () => {
        finish(abortError());
        state.transfer?.abort(); state.task?.abort();
      };
      if (signal.aborted) { finish(abortError()); return; }
      signal.addEventListener('abort', cancel, { once: true });
      const options = {
        conflictAction: 'uniquify', saveAs: false,
        onprogress: progress => {
          if (settled || download !== state) return;
          state.loaded = progress.loaded || state.loaded;
          state.total = progress.total || state.total;
          render();
        },
        onload: () => finish(),
        ontimeout: () => finish(new Error('下载超时，请重试')),
        onerror: error => {
          const extension = row.kind === 'image' ? resolved.extension : 'mp4';
          const hints = { not_enabled: '请在油猴设置中开启下载功能',
            not_whitelisted: `请在油猴设置中允许 .${extension} 文件下载`,
            not_permitted: '请授予油猴下载权限', not_supported: '当前浏览器不支持油猴下载' };
          finish(new Error(hints[error?.error] || `保存失败（${error?.error || '网络错误'}），请重新探测后重试`));
        },
      };
      const save = url => {
        if (settled) return;
        try {
          state.task = GM_download({ url, name: state.name,
            ...(typeof url === 'string' ? { headers: { 'User-Agent': MOBILE_UA, Referer: 'https://www.douyin.com/' } } : {}),
            ...options });
        } catch (error) { finish(error); }
      };
      try {
        if (GM_info.downloadMode !== 'browser') { save(resolved.url); return; }
        // 普通下载和 ZIP 使用同一个传输入口验证响应与取消状态。
        const resolvedRow = { ...row, ...resolved };
        fetchBlob(resolved.url, state, resolvedRow).then(blob => {
          if (settled) return;
          resolved.extension = resolvedRow.extension;
          state.name = filename(item, resolvedRow);
          state.total = blob.size; state.loaded = blob.size;
          render(); save(blob);
        }, finish);
      } catch (error) { finish(error); }
    });
  }

  async function startDownload(item, selection) {
    if (download) return;
    // 点击时重新核对；整组队列固定作品和顺序，切换卡片不改变已开始的下载。
    syncCurrent();
    if (item.aweme_id !== activeId) return;
    const rows = Array.isArray(selection) ? [...selection] : [selection];
    if (!rows.length) return;
    const state = { name: '', loaded: 0, total: 0, task: null, transfer: null,
      controller: new AbortController(), cancelled: false, count: rows.length, completed: 0 };
    download = state;
    let message = '';
    try {
      for (const row of rows) {
        if (state.controller.signal.aborted) throw abortError();
        state.name = filename(item, row);
        state.loaded = 0; state.total = row.size; state.task = null; state.transfer = null;
        render();
        if (row.kind === 'live') {
          const entries = await albumFiles(item, row, state);
          if (state.controller.signal.aborted) throw abortError();
          state.name = filename(item, row);
          await saveZipBlob(state.name, buildZip(entries), state);
          state.completed++;
          continue;
        }
        // 移动端档位下载前重新取签名；图片单独验证格式，不走视频播放接口。
        const resolved = row.kind === 'image' ? await measureImage(row.url, state.controller.signal)
          : row.ratio ? await probe(item.video.play_addr.uri, row.ratio, state.controller.signal)
          : await measure(row.url, state.controller.signal);
        if (state.controller.signal.aborted) throw abortError();
        state.name = filename(item, { ...row, ...resolved });
        state.total = resolved.size || state.total;
        await saveDownload(item, row, resolved, state);
        state.completed++;
      }
      const done = GM_info.downloadMode === 'browser' ? '下载完成' : '已交给浏览器保存，请查看下载列表';
      message = state.count > 1 ? `${done}：${state.completed} 张图片` : `${done}：${state.name}`;
    } catch (error) {
      const reason = state.cancelled ? '下载已取消' : `下载失败：${state.name} · ${error.message}`;
      const progress = GM_info.downloadMode === 'browser' ? '已完成' : '已提交';
      message = state.count > 1 ? `${reason}（${progress} ${state.completed}/${state.count} 张）` : reason;
    } finally {
      if (download === state) {
        download = null;
        ui.downloadMessage.textContent = message;
        render();
      }
    }
  }

  function fetchBlob(url, state, row) {
    if (!mediaUrl(url)) return Promise.reject(new Error('下载地址不属于允许的媒体域名'));
    return new Promise((resolve, reject) => {
      const signal = state.controller.signal;
      let settled = false;
      const finish = (error, blob) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        error ? reject(error) : resolve(blob);
      };
      const cancel = () => { finish(abortError()); state.transfer?.abort(); };
      if (signal.aborted) { finish(abortError()); return; }
      signal.addEventListener('abort', cancel, { once: true });
      try {
        state.transfer = GM_xmlhttpRequest({
          method: 'GET', url, timeout: 120000, responseType: 'blob',
          headers: { 'User-Agent': MOBILE_UA, Referer: 'https://www.douyin.com/' },
          onprogress: response => {
            if (settled || download !== state) return;
            state.loaded = response.loaded || state.loaded;
            state.total = response.total || state.total;
            render();
          },
          onload: response => {
            if (settled) return;
            if (response.status !== 200 || !(response.response instanceof Blob) || response.response.size === 0) {
              finish(new Error(`文件请求失败（HTTP ${response.status}）`)); return;
            }
            const type = header(response, 'content-type') || response.response.type;
            if (!mediaUrl(response.finalUrl || url) || /text\/|json/i.test(type)) {
              finish(new Error('下载地址未返回允许的媒体文件')); return;
            }
            if (row.kind === 'image') {
              // 实际响应决定图片格式，而不是探测时的 HEAD 结果。
              const extension = imageExtension(type);
              if (!extension) {
                finish(new Error('下载地址未返回允许的图片文件')); return;
              }
              row.extension = extension;
            }
            finish(null, response.response);
          },
          onerror: () => finish(new Error('文件传输失败，请重新探测后重试')),
          ontimeout: () => finish(new Error('文件传输超时，请重试')),
          onabort: () => finish(abortError()),
        });
      } catch (error) { finish(error); }
    });
  }

  async function albumFiles(item, row, state) {
    const signal = state.controller.signal;
    const photo = { ...(row.kind === 'live' ? row.photo : row) };
    const resolved = await measureImage(photo.url, signal);
    Object.assign(photo, resolved);
    const image = await fetchBlob(photo.url, state, photo);
    if (signal.aborted) throw abortError();
    if (row.kind !== 'live') return [{ name: filename(item, photo), data: new Uint8Array(await image.arrayBuffer()) }];
    let jpeg = image;
    if (photo.extension !== 'jpg') {
      // 只有网页未提供 JPEG 时转换静态图；视频始终保留原始编码。
      const bitmap = await createImageBitmap(image);
      try {
        if (signal.aborted) throw abortError();
        const canvas = document.createElement('canvas');
        canvas.width = bitmap.width; canvas.height = bitmap.height;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('浏览器无法转换实况照片封面');
        context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0);
        jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
        if (!jpeg) throw new Error('实况照片封面转换失败');
      } finally { bitmap.close(); }
    }
    if (signal.aborted) throw abortError();
    state.loaded = 0; state.total = row.video.size;
    state.name = filename(item, { ...row, extension: 'mov' }); render();
    const video = await measure(row.video.url, signal);
    const movie = await fetchBlob(video.url, state, { kind: 'video' });
    const photoBytes = new Uint8Array(await jpeg.arrayBuffer()), movieBytes = new Uint8Array(await movie.arrayBuffer());
    if (signal.aborted) throw abortError();
    const pair = makeLivePhoto(photoBytes, movieBytes);
    return [{ name: filename(item, { ...row, extension: 'jpg' }), data: pair.photo },
      { name: filename(item, { ...row, extension: 'mov' }), data: pair.video }];
  }

  // Apple Live Photo：JPEG 的 MakerApple[17] 与 MOV content.identifier 配对，
  // mebx 轨道中的 still-image-time 指定关键照片时刻。保留原视频样本，不重新编码。
  function makeLivePhoto(photo, movie, identifier = crypto.randomUUID().toUpperCase()) {
    if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(identifier)) throw new Error('实况照片标识无效');
    const text = value => new TextEncoder().encode(value);
    const join = (...parts) => {
      const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
      let offset = 0;
      for (const part of parts) { result.set(part, offset); offset += part.length; }
      return result;
    };
    const words = (...values) => {
      const result = new Uint8Array(values.length * 4), view = new DataView(result.buffer);
      values.forEach((value, index) => view.setUint32(index * 4, value));
      return result;
    };
    const box = (type, ...parts) => {
      const body = join(...parts);
      return join(words(body.length + 8), typeof type === 'number' ? words(type) : text(type), body);
    };
    const fail = message => { throw new Error(`无法生成实况照片：${message}`); };

    // 新 IFD 追加在原 TIFF 后，旧字段的绝对偏移不变，保留方向、色彩和其他 EXIF。
    if (photo[0] !== 0xFF || photo[1] !== 0xD8) fail('静态照片不是 JPEG');
    let exifStart = 2, exifEnd = 2, tiff = new Uint8Array([77, 77, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0, 0, 0]);
    let foundExif = false, foundScan = false;
    const photoView = new DataView(photo.buffer, photo.byteOffset, photo.byteLength);
    for (let offset = 2; offset + 4 <= photo.length;) {
      if (photo[offset] !== 0xFF) fail('JPEG 段结构无效');
      const marker = photo[offset + 1], length = photoView.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > photo.length) fail('JPEG 段已截断');
      if (marker === 0xDA) { foundScan = true; break; }
      if (marker === 0xE1 && length >= 8 && new TextDecoder().decode(photo.subarray(offset + 4, offset + 10)) === 'Exif\0\0') {
        if (foundExif) fail('JPEG 存在重复 EXIF');
        foundExif = true; exifStart = offset; exifEnd = offset + 2 + length;
        tiff = photo.slice(offset + 10, exifEnd);
      }
      offset += length + 2;
    }
    if (!foundScan || photo[photo.length - 2] !== 0xFF || photo[photo.length - 1] !== 0xD9) fail('JPEG 数据不完整');
    const little = tiff[0] === 73 && tiff[1] === 73;
    if (!little && !(tiff[0] === 77 && tiff[1] === 77)) fail('EXIF 字节序无效');
    const tiffView = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    if (tiff.length < 8 || tiffView.getUint16(2, little) !== 42) fail('EXIF 头无效');
    const readIfd = offset => {
      if (offset < 8 || offset + 2 > tiff.length) fail('EXIF 目录偏移无效');
      const count = tiffView.getUint16(offset, little), end = offset + 2 + count * 12;
      if (end + 4 > tiff.length) fail('EXIF 目录已截断');
      return { entries: Array.from({ length: count }, (_, index) => tiff.slice(offset + 2 + index * 12, offset + 14 + index * 12)),
        next: tiffView.getUint32(end, little) };
    };
    const tagOf = entry => new DataView(entry.buffer).getUint16(0, little);
    const entry = (tag, type, count, value) => {
      const data = new Uint8Array(12), view = new DataView(data.buffer);
      view.setUint16(0, tag, little); view.setUint16(2, type, little);
      view.setUint32(4, count, little); view.setUint32(8, value, little);
      return data;
    };
    const ifd = (entries, next) => {
      entries.sort((a, b) => tagOf(a) - tagOf(b));
      const result = new Uint8Array(2 + entries.length * 12 + 4), view = new DataView(result.buffer);
      view.setUint16(0, entries.length, little);
      entries.forEach((value, index) => result.set(value, 2 + index * 12));
      view.setUint32(result.length - 4, next, little);
      return result;
    };
    const root = readIfd(tiffView.getUint32(4, little));
    const pointer = root.entries.find(value => tagOf(value) === 0x8769);
    if (pointer && (new DataView(pointer.buffer).getUint16(2, little) !== 4 || new DataView(pointer.buffer).getUint32(4, little) !== 1)) fail('EXIF 子目录指针无效');
    const exif = pointer ? readIfd(new DataView(pointer.buffer).getUint32(8, little)) : { entries: [], next: 0 };
    // Apple MakerNote 使用自身起点的偏移和大端 IFD，与外围 TIFF 字节序无关。
    const maker = join(text('Apple iOS\0'), new Uint8Array([0, 1, 77, 77, 0, 1, 0, 17, 0, 2]), words(37, 32, 0), text(identifier + '\0'));
    const padding = new Uint8Array(tiff.length % 2), makerOffset = tiff.length + padding.length;
    const exifOffset = makerOffset + maker.length + 1;
    const newExif = ifd([...exif.entries.filter(value => tagOf(value) !== 0x927C), entry(0x927C, 7, maker.length, makerOffset)], exif.next);
    const rootOffset = exifOffset + newExif.length;
    const newRoot = ifd([...root.entries.filter(value => tagOf(value) !== 0x8769), entry(0x8769, 4, 1, exifOffset)], root.next);
    const newTiff = join(tiff, padding, maker, new Uint8Array(1), newExif, newRoot);
    new DataView(newTiff.buffer).setUint32(4, rootOffset, little);
    const appLength = newTiff.length + 8;
    if (appLength > 65535) fail('EXIF 超出 JPEG 段大小限制');
    const app = join(new Uint8Array([255, 225, appLength >> 8, appLength & 255]), text('Exif\0\0'), newTiff);
    const jpeg = join(photo.subarray(0, exifStart), app, photo.subarray(exifEnd));

    // 不移动原 mdat：把旧 moov 标为 free，再追加新媒体样本与 moov，原 stco/co64 无需重写。
    if (movie.length > 0xFFFFFFFF - 65536) fail('视频过大');
    const view = new DataView(movie.buffer, movie.byteOffset, movie.byteLength);
    const typeAt = offset => String.fromCharCode(...movie.subarray(offset, offset + 4));
    const boxes = (start, end) => {
      const result = [];
      for (let offset = start; offset < end;) {
        if (offset + 8 > end || result.length > 10000) fail('视频容器已截断');
        let size = view.getUint32(offset), head = 8;
        if (size === 1) {
          if (offset + 16 > end) fail('视频扩展长度已截断');
          size = Number(view.getBigUint64(offset + 8)); head = 16;
        } else if (size === 0) size = end - offset;
        if (!Number.isSafeInteger(size) || size < head || offset + size > end) fail('视频容器长度无效');
        result.push({ type: typeAt(offset + 4), start: offset, body: offset + head, end: offset + size });
        offset += size;
      }
      return result;
    };
    const children = atom => boxes(atom.body, atom.end);
    const required = (list, type, minSize = 0) => {
      const matches = list.filter(atom => atom.type === type);
      if (matches.length !== 1 || matches[0].end - matches[0].body < minSize) fail(`视频缺少有效的 ${type}`);
      return matches[0];
    };
    const copy = atom => movie.slice(atom.start, atom.end);
    const top = boxes(0, movie.length), moov = required(top, 'moov'), ftyp = required(top, 'ftyp', 12);
    const moovParts = children(moov), mvhd = required(moovParts, 'mvhd', 100);
    const mdats = top.filter(atom => atom.type === 'mdat');
    if (!mdats.length || top.some(atom => atom.type === 'moof') || moovParts.some(atom => atom.type === 'mvex')) fail('暂不支持分片视频');
    const version = movie[mvhd.body];
    if (version > 1 || (version === 1 && mvhd.end - mvhd.body < 112)) fail('视频时间头无效');
    const timescale = view.getUint32(mvhd.body + (version ? 20 : 12));
    const duration = version ? Number(view.getBigUint64(mvhd.body + 24)) : view.getUint32(mvhd.body + 16);
    if (!timescale || !Number.isSafeInteger(duration) || duration <= 0 || duration > 0xFFFFFFFF) fail('视频时长无效或过长');
    let maxId = 0, hasVideo = false;
    const tracks = moovParts.filter(atom => atom.type === 'trak').filter(track => {
      const parts = children(track), tkhd = required(parts, 'tkhd', 84), mdia = required(parts, 'mdia');
      const media = children(mdia), handler = required(media, 'hdlr', 12), kind = typeAt(handler.body + 8);
      // 新实况元数据取代来源文件的 metadata，防止继承旧的照片标记。
      if (kind !== 'vide' && kind !== 'soun') return false;
      const trackVersion = movie[tkhd.body];
      if (trackVersion > 1 || (trackVersion === 1 && tkhd.end - tkhd.body < 96)) fail('视频轨道头无效');
      maxId = Math.max(maxId, view.getUint32(tkhd.body + (trackVersion ? 20 : 12)));
      const minf = required(media, 'minf'), mediaInfo = children(minf), stbl = required(mediaInfo, 'stbl'), table = children(stbl);
      const dinf = required(mediaInfo, 'dinf'), dref = required(children(dinf), 'dref', 8);
      const references = boxes(dref.body + 8, dref.end);
      if (references.length !== 1 || view.getUint32(dref.body + 4) !== 1 || references[0].end - references[0].body < 4 ||
        !['url ', 'alis'].includes(references[0].type) || !(view.getUint32(references[0].body) & 1)) fail('视频含外部媒体引用');
      const stsd = required(table, 'stsd', 8), samples = boxes(stsd.body + 8, stsd.end);
      if (samples.length !== view.getUint32(stsd.body + 4) || samples.some(sample =>
        sample.end - sample.body < 8 || view.getUint16(sample.body + 6) !== 1)) fail('视频样本描述无效');
      if (kind === 'vide') {
        if (!samples.length || samples.some(sample => !['avc1', 'hvc1', 'hev1'].includes(sample.type))) fail('视频编码不支持苹果实况照片');
        hasVideo = true;
      } else if (!samples.length || samples.some(sample => sample.type !== 'mp4a')) fail('音频编码不支持苹果实况照片');
      const chunks = table.filter(atom => atom.type === 'stco' || atom.type === 'co64');
      if (chunks.length !== 1 || chunks[0].end - chunks[0].body < 8) fail('视频索引无效');
      const chunk = chunks[0], count = view.getUint32(chunk.body + 4), stride = chunk.type === 'co64' ? 8 : 4;
      if (!count || chunk.body + 8 + count * stride !== chunk.end) fail('视频索引已截断');
      // 必须联合校验每个 chunk 覆盖的全部样本，起点在 mdat 内不足以证明正文完整。
      const stsz = required(table, 'stsz', 12), sampleSize = view.getUint32(stsz.body + 4), sampleCount = view.getUint32(stsz.body + 8);
      if (!sampleCount || stsz.body + 12 + (sampleSize ? 0 : sampleCount * 4) !== stsz.end || table.some(atom => atom.type === 'stz2')) fail('视频样本大小表无效');
      const stsc = required(table, 'stsc', 8), runCount = view.getUint32(stsc.body + 4), runs = [];
      if (!runCount || stsc.body + 8 + runCount * 12 !== stsc.end) fail('视频样本分组表已截断');
      for (let index = 0; index < runCount; index++) {
        const offset = stsc.body + 8 + index * 12;
        const first = view.getUint32(offset), samplesPerChunk = view.getUint32(offset + 4), description = view.getUint32(offset + 8);
        if ((index === 0 ? first !== 1 : first <= runs[index - 1].first) || first > count || !samplesPerChunk || !description || description > samples.length) fail('视频样本分组无效');
        runs.push({ first, samplesPerChunk });
      }
      const stts = required(table, 'stts', 8), timeCount = view.getUint32(stts.body + 4);
      if (!timeCount || stts.body + 8 + timeCount * 8 !== stts.end) fail('视频样本时间表已截断');
      let timedSamples = 0;
      for (let index = 0; index < timeCount; index++) {
        const offset = stts.body + 8 + index * 8, entries = view.getUint32(offset);
        if (!entries || !view.getUint32(offset + 4)) fail('视频样本时间无效');
        timedSamples += entries;
        if (timedSamples > sampleCount) fail('视频样本数量不一致');
      }
      if (timedSamples !== sampleCount) fail('视频样本数量不一致');
      let sampleIndex = 0, runIndex = 0;
      for (let index = 0; index < count; index++) {
        if (runs[runIndex + 1]?.first === index + 1) runIndex++;
        const length = runs[runIndex].samplesPerChunk;
        if (sampleIndex + length > sampleCount) fail('视频样本分组超出大小表');
        let bytes = sampleSize * length;
        if (!sampleSize) for (let sample = sampleIndex; sample < sampleIndex + length; sample++) bytes += view.getUint32(stsz.body + 12 + sample * 4);
        const offset = chunk.body + 8 + index * stride;
        const position = stride === 8 ? Number(view.getBigUint64(offset)) : view.getUint32(offset);
        if (!Number.isSafeInteger(position) || !Number.isSafeInteger(bytes) || bytes <= 0 ||
          !mdats.some(atom => position >= atom.body && position + bytes <= atom.end)) fail('视频样本超出媒体数据范围');
        sampleIndex += length;
      }
      if (sampleIndex !== sampleCount) fail('视频样本分组未覆盖全部样本');
      return true;
    });
    if (!hasVideo || maxId >= 0xFFFFFFFE) fail('没有可用的视频轨道');
    const trackId = maxId + 1, stillTime = Math.floor(duration / 2);
    const markerDuration = Math.max(1, Math.min(duration - stillTime, Math.round(timescale / 30)));
    const matrix = words(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);
    const tkhd = box('tkhd', words(15, 0, 0, trackId, 0, stillTime + markerDuration, 0, 0, 0, 0), matrix, words(0, 0));
    const edits = box('edts', box('elst', words(0, 2, stillTime, 0xFFFFFFFF, 0x10000, markerDuration, 0, 0x10000)));
    const mdhd = box('mdhd', words(0, 0, 0, timescale, markerDuration, 0x55C40000));
    const handler = (component, subtype, name) => box('hdlr', words(0), text(component + subtype + 'appl'), words(0, 0), new Uint8Array([name.length]), text(name));
    const mebx = box('mebx', words(0, 1), box('keys', box(1,
      box('keyd', text('mdtacom.apple.quicktime.still-image-time')), box('dtyp', words(0, 65)))));
    const stbl = box('stbl', box('stsd', words(0, 1), mebx), box('stts', words(0, 1, 1, markerDuration)),
      box('stsc', words(0, 1, 1, 1, 1)), box('stsz', words(0, 9, 1)), box('stco', words(0, 1, movie.length + 8)));
    const minf = box('minf', box('gmhd', box('gmin', words(0, 0x00408000, 0x80008000, 0))),
      handler('dhlr', 'alis', 'Core Media Data Handler'), box('dinf', box('dref', words(0, 1), box('alis', words(1)))), stbl);
    const metadataTrack = box('trak', tkhd, edits, box('mdia', mdhd, handler('mhlr', 'meta', 'Core Media Metadata'), minf));
    const metadata = box('meta', box('hdlr', words(0, 0), text('mdta'), words(0, 0, 0), new Uint8Array(2)),
      box('keys', words(0, 1), box('mdta', text('com.apple.quicktime.content.identifier'))),
      box('ilst', box(1, box('data', words(1, 0), text(identifier)))));
    const header = copy(mvhd);
    new DataView(header.buffer).setUint32(header.length - 4, trackId + 1);
    const updatedMoov = box('moov', header, ...tracks.map(copy), metadataTrack, metadata);
    const original = movie.slice();
    original.set(text('free'), moov.start + 4);
    // 保持 ftyp 长度与所有原始偏移；改为 QuickTime 兼容品牌。
    original.set(text('qt  '), ftyp.body);
    for (let offset = ftyp.body + 8; offset + 4 <= ftyp.end; offset += 4) original.set(text('qt  '), offset);
    for (const atom of top) if (view.getUint32(atom.start) === 0) new DataView(original.buffer).setUint32(atom.start, atom.end - atom.start);
    return { photo: jpeg, video: join(original, box('mdat', box(1, new Uint8Array([0]))), updatedMoov) };
  }

  // 图片本身已是压缩格式，ZIP 采用 Store（不二次压缩）；文件名按 UTF-8 标志位写入。
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let value = i;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
      table[i] = value >>> 0;
    }
    return table;
  })();

  function crc32(data) {
    let crc = -1;
    for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }

  function buildZip(entries) {
    const encoder = new TextEncoder();
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((Math.max(0, now.getFullYear() - 1980) & 0x7F) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const chunks = [];
    const central = [];
    let offset = 0;
    let centralSize = 0;
    const push = bytes => { chunks.push(bytes); offset += bytes.length; };
    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const data = entry.data;
      const size = data.length;
      if (size >= 0xFFFFFFFF) throw new Error('单张图片超过 4 GiB，无法打包');
      const crc = crc32(data);
      const headerOffset = offset;
      const local = new Uint8Array(30 + name.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 0x04034B50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true);
      view.setUint16(10, dosTime, true);
      view.setUint16(12, dosDate, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, size, true);
      view.setUint32(22, size, true);
      view.setUint16(26, name.length, true);
      local.set(name, 30);
      push(local); push(data);
      const directory = new Uint8Array(46 + name.length);
      const dir = new DataView(directory.buffer);
      dir.setUint32(0, 0x02014B50, true);
      dir.setUint16(4, 20, true);
      dir.setUint16(6, 20, true);
      dir.setUint16(8, 0x0800, true);
      dir.setUint16(12, dosTime, true);
      dir.setUint16(14, dosDate, true);
      dir.setUint32(16, crc, true);
      dir.setUint32(20, size, true);
      dir.setUint32(24, size, true);
      dir.setUint16(28, name.length, true);
      dir.setUint32(42, headerOffset, true);
      directory.set(name, 46);
      central.push(directory);
      centralSize += directory.length;
    }
    // 条目数或总大小超出 ZIP 传统格式上限时直接放弃，避免生成损坏的压缩包。
    if (entries.length > 0xFFFF || offset >= 0xFFFFFFFF) throw new Error('图片数量或体积过多，无法打包为 ZIP');
    const centralOffset = offset;
    for (const record of central) push(record);
    const end = new Uint8Array(22);
    const footer = new DataView(end.buffer);
    footer.setUint32(0, 0x06054B50, true);
    footer.setUint16(8, entries.length, true);
    footer.setUint16(10, entries.length, true);
    footer.setUint32(12, centralSize, true);
    footer.setUint32(16, centralOffset, true);
    push(end);
    return new Blob(chunks, { type: 'application/zip' });
  }

  function saveZipBlob(name, blob, state) {
    return new Promise((resolve, reject) => {
      const signal = state.controller.signal;
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', cancel);
        error ? reject(error) : resolve();
      };
      const cancel = () => { finish(abortError()); state.task?.abort(); };
      if (signal.aborted) { finish(abortError()); return; }
      signal.addEventListener('abort', cancel, { once: true });
      try {
        state.task = GM_download({ url: blob, name, conflictAction: 'uniquify', saveAs: false,
          ontimeout: () => finish(new Error('下载超时，请重试')),
          onerror: error => finish(new Error(error?.error === 'not_whitelisted'
            ? '请在油猴设置中允许 .zip 文件下载'
            : `保存失败（${error?.error || '未知错误'}），请重试`)),
          onload: () => finish() });
      } catch (error) { finish(error); }
    });
  }

  async function startZipDownload(item, rows) {
    if (download) return;
    // 点击时重新核对；打包内容固定为开始时的已识别图片，切换卡片不影响进行中的打包。
    syncCurrent();
    if (item.aweme_id !== activeId) return;
    if (!rows.length) return;
    const state = { kind: 'zip', phase: 'download', name: '', loaded: 0, total: 0, task: null, transfer: null,
      controller: new AbortController(), cancelled: false, count: rows.length, completed: 0 };
    download = state;
    let message = '';
    try {
      const files = [];
      for (const row of rows) {
        if (state.controller.signal.aborted) throw abortError();
        state.name = filename(item, row);
        state.loaded = 0; state.total = row.size || 0;
        state.phase = 'download';
        render();
        files.push(...await albumFiles(item, row, state));
        state.completed++;
      }
      if (state.controller.signal.aborted) throw abortError();
      state.phase = 'pack'; state.name = ''; state.loaded = 0; state.total = 0;
      render();
      const zip = buildZip(files);
      state.phase = 'save';
      render();
      await saveZipBlob(zipName(item), zip, state);
      message = `ZIP 已交给浏览器保存：${state.completed} 张图片`;
    } catch (error) {
      const reason = state.cancelled ? '打包下载已取消'
        : `打包下载失败：${state.phase === 'pack' ? '正在生成 ZIP' : state.name} · ${error.message}`;
      message = state.phase === 'download' && state.count > 1
        ? `${reason}（已完成 ${state.completed}/${state.count} 张）` : reason;
    } finally {
      if (download === state) {
        download = null;
        ui.downloadMessage.textContent = message;
        render();
      }
    }
  }

  function node(tag, text, className) {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function enableIconDragging(button, onMoved) {
    const storageKey = 'download-icon-position';
    const stored = GM_getValue(storageKey, null);
    let position = stored && [stored.x, stored.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)
      ? { x: stored.x, y: stored.y } : null;
    let drag = null;
    let suppressClick = false;
    const bounds = () => ({
      left: Math.min(8, Math.max(0, innerWidth - 46)),
      top: Math.min(8, Math.max(0, innerHeight - 46)),
      right: Math.max(0, innerWidth - 54),
      bottom: Math.max(0, innerHeight - 54),
    });
    const place = (left, top) => {
      const b = bounds();
      const x = Math.min(Math.max(b.left, left), Math.max(b.left, b.right));
      const y = Math.min(Math.max(b.top, top), Math.max(b.top, b.bottom));
      button.style.left = `${x}px`; button.style.top = `${y}px`;
      return { x: b.right > b.left ? (x - b.left) / (b.right - b.left) : 0,
        y: b.bottom > b.top ? (y - b.top) / (b.bottom - b.top) : 0 };
    };
    const update = video => {
      if (drag) return;
      if (position) {
        const b = bounds();
        place(b.left + position.x * (b.right - b.left), b.top + position.y * (b.bottom - b.top));
      } else if (video) {
        place(video.box.right - 58, video.box.top + video.box.height * 0.56 - 23);
      }
      onMoved?.();
    };
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.isPrimary === false) return;
      event.stopPropagation();
      const box = button.getBoundingClientRect();
      suppressClick = false;
      drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: box.left, top: box.top, moved: false };
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true; suppressClick = true;
      event.preventDefault(); event.stopPropagation();
      place(drag.left + dx, drag.top + dy);
      onMoved?.();
    });
    const finish = (event, cancelled) => {
      if (!drag || event.pointerId !== drag.id) return;
      const moved = drag.moved;
      drag = null;
      if (moved && !cancelled) {
        position = place(parseFloat(button.style.left), parseFloat(button.style.top));
        GM_setValue(storageKey, position);
      }
      if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
      if (moved) { event.preventDefault(); event.stopPropagation(); }
    };
    button.addEventListener('pointerup', event => finish(event, false));
    button.addEventListener('pointercancel', event => finish(event, true));
    button.addEventListener('lostpointercapture', event => finish(event, true));
    return { update, ignoreClick: event => event.detail !== 0 && suppressClick };
  }

  // 面板不固定在右下角，而是锚定下载图标：图标在上半屏向下弹出，在下半屏向上弹出；放不下时换另一侧。
  function placePanel() {
    if (!ui || ui.panel.hidden || ui.button.hidden) return;
    const { panel, button } = ui;
    const icon = button.getBoundingClientRect();
    const width = panel.offsetWidth, height = panel.offsetHeight;
    if (!width || !height) return;
    const margin = 10, edge = 8;
    const left = Math.min(Math.max(edge, icon.left + icon.width / 2 - width / 2), Math.max(edge, innerWidth - width - edge));
    const downward = icon.top + icon.height / 2 <= innerHeight / 2;
    const belowTop = icon.bottom + margin;
    const aboveTop = icon.top - margin - height;
    const minTop = edge;
    const maxTop = Math.max(minTop, innerHeight - height - edge);
    let top = downward ? belowTop : aboveTop;
    if (top < minTop || top > maxTop) {
      const flip = downward ? aboveTop : belowTop;
      if (flip >= minTop && flip <= maxTop) top = flip;
    }
    top = Math.min(Math.max(minTop, top), maxTop);
    panel.style.left = `${left}px`;
    panel.style.top = `${top}px`;
  }

  function render() {
    if (!ui) return;
    const state = inspection?.id === activeId ? inspection : null;
    const item = state?.item || items.get(activeId);
    const album = item?.kind === 'album';
    const hasLive = Boolean(item?.images.some(image => image.live));
    const waiting = Boolean(pendingProbe);
    ui.heading.textContent = album ? '抖音图集下载' : '抖音视频下载';
    ui.column.textContent = album ? '图片' : '档位';
    ui.stop.hidden = !state?.busy && !waiting;
    ui.all.hidden = !album || !state?.rows.length;
    ui.all.disabled = Boolean(download || state?.busy);
    ui.all.textContent = `下载${state?.rows.length === item?.images.length ? '全部' : '已识别'}${hasLive ? '' : '图片'}（${state?.rows.length || 0} 张）`;
    ui.zip.hidden = ui.all.hidden;
    ui.zip.disabled = ui.all.disabled;
    ui.zip.textContent = `下载为 ZIP（${state?.rows.length || 0} 张）`;
    ui.status.textContent = notice || (waiting
      ? '正在识别当前作品……'
      : state?.busy
      ? album ? `正在读取图集 · 已找到 ${state.rows.length}/${item.images.length} 张图片` : `正在探测画质 · 已找到 ${state.rows.length} 个版本`
      : download
      ? '下载进行中'
      : item
      ? `${item.author?.nickname || '作者未知'} · ${state ? album ? `已识别 ${state.rows.length}/${item.images.length} 张图片` : '画质探测完成' : '点击下载图标开始探测'}`
      : '点击下载图标，自动识别当前视频或图集。');
    ui.title.textContent = item?.desc || '';
    ui.rows.replaceChildren();
    for (const row of state?.rows || []) {
      const tr = node('tr');
      const quality = node('td', row.label);
      if (row.kind === 'image') quality.append(node('small', row.extension.toUpperCase()));
      if (row.kind === 'live') quality.append(node('small', 'Live Photo · JPG + MOV'));
      if (row.codec) quality.append(node('small', `${row.codec}${row.bitrate ? ` · ${(row.bitrate / 1e6).toFixed(2)} Mbps` : ''}`));
      tr.append(quality, node('td', row.width && row.height ? `${row.width} × ${row.height}` : '未知'), node('td', humanSize(row.size)));
      const action = node('td');
      const button = node('button', row.kind === 'live' ? '下载实况' : '下载');
      button.disabled = Boolean(download);
      button.addEventListener('click', () => startDownload(item, row));
      action.append(button);
      if (row.kind === 'live') {
        const still = node('button', '静态图');
        still.disabled = Boolean(download);
        still.addEventListener('click', () => startDownload(item, row.photo));
        action.append(still);
      }
      tr.append(action); ui.rows.append(tr);
    }
    ui.diagnostics.hidden = !state?.errors.length;
    ui.errors.textContent = state?.errors.join('\n') || '';
    ui.empty.textContent = !state
      ? waiting ? '收到当前作品数据后会自动开始探测。' : '点击当前作品旁的下载图标开始探测。'
      : state.busy ? album ? '正在读取图片格式和文件大小……' : '正在读取当前视频的播放版本和文件大小……'
      : state.rows.length ? album ? hasLive
        ? '实况照片保存为 ZIP 内的同名 JPG + MOV；解压后在 Mac「照片」同时导入这两个文件。分辨率为动态画面尺寸，大小为两份源文件合计。'
        : '按图集顺序保存独立图片；尺寸来自作品数据，格式以文件响应为准。' : '重复直链已合并；分辨率未知时不会猜测画质。'
      : '当前作品未取得可下载文件，请检查登录状态和油猴跨域授权。';
    ui.cancel.hidden = !download;
    if (download) {
      ui.bar.hidden = false;
      ui.bar.classList.toggle('packing', download.kind === 'zip' && download.phase !== 'download');
      if (download.kind === 'zip' && download.phase === 'pack') {
        ui.downloadMessage.textContent = `正在打包 ZIP…（已下载 ${download.completed}/${download.count} 张图片）`;
      } else if (download.kind === 'zip' && download.phase === 'save') {
        ui.downloadMessage.textContent = `打包完成，正在保存 ZIP（${download.count} 张图片）……`;
      } else if (download.count > 1) {
        ui.downloadMessage.textContent = `[${download.completed + 1}/${download.count}] ${download.name}：${humanSize(download.loaded)} / ${humanSize(download.total)}`;
      } else {
        ui.downloadMessage.textContent = `${download.name}：${humanSize(download.loaded)} / ${humanSize(download.total)}`;
      }
      // ZIP 下载阶段按 (已完成张数 + 当前张进度)/总数 换算；打包与保存阶段由条纹动画表示。
      const current = download.total ? Math.min(1, download.loaded / download.total) : 0;
      const ratio = download.kind === 'zip' && download.phase !== 'download' ? 1
        : (download.completed + current) / download.count;
      ui.fill.style.width = `${Math.round(Math.min(1, ratio) * 100)}%`;
    } else {
      ui.bar.hidden = true;
      ui.bar.classList.remove('packing');
      ui.fill.style.width = '0';
    }
    placePanel();
  }

  function mount() {
    const host = node('div');
    host.id = 'douyin-quality-downloader';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = node('style');
    style.textContent = `
      :host{all:initial;position:fixed;left:0;top:0;z-index:2147483646;font:14px/1.5 system-ui,sans-serif;color:#f3f4f6}
      *{box-sizing:border-box}button{font:inherit;cursor:pointer;border:1px solid #50535f;border-radius:7px;padding:7px 11px;background:#323644;color:#fff}
      button:disabled{cursor:default;opacity:.5}button:hover:enabled{background:#424958}
      .video-action{position:fixed;width:46px;height:46px;display:grid;place-items:center;border:1px solid #ffffff55;border-radius:50%;background:#191b22d9;box-shadow:0 2px 10px #0008;padding:0;touch-action:none;user-select:none;cursor:grab}
      .video-action:active{cursor:grabbing}
      .video-action svg{width:23px;height:23px;fill:none;stroke:#fff;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
      .panel{position:fixed;left:0;top:0;width:min(580px,calc(100vw - 16px));max-height:76vh;overflow:auto;background:#1b1d25;border:1px solid #414452;border-radius:10px;padding:16px;box-shadow:0 8px 32px #0008}
      [hidden]{display:none!important}.head,.actions{display:flex;gap:8px;align-items:center}.head{justify-content:space-between}h2{font-size:17px;margin:0}p{margin:10px 0;overflow-wrap:anywhere}
      .title{color:#cbd0dc;max-height:72px;overflow:auto}
      table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}th,td{text-align:left;border-bottom:1px solid #383c49;padding:9px 4px}td button+button{margin:4px 0 0 4px}small{display:block;color:#9fa9bc;font-size:11px}
      .hint{color:#a7aebc;font-size:12px}pre{white-space:pre-wrap;font-size:12px;color:#eeb2bb}details{margin-top:8px}.download{border-top:1px solid #383c49;margin-top:12px;padding-top:8px}
      .bar{height:6px;background:#323644;border-radius:3px;margin:10px 0 2px;overflow:hidden}
      .fill{height:100%;width:0;background:#5eb1ff;border-radius:3px;transition:width .15s ease}
      .bar.packing .fill{width:100%;background:repeating-linear-gradient(90deg,#5eb1ff 0 12px,#3d8fd6 12px 24px);animation:zip-pack .7s linear infinite}
      @keyframes zip-pack{to{background-position:24px 0}}
    `;
    const panel = node('section', undefined, 'panel'); panel.hidden = true;
    const head = node('div', undefined, 'head'); const heading = node('h2', '抖音视频下载'); head.append(heading);
    const status = node('p');
    const title = node('p', undefined, 'title');
    const actions = node('div', undefined, 'actions');
    const stop = node('button', '停止探测'); stop.addEventListener('click', () => {
      pendingProbe = null; notice = '已停止探测'; inspectController?.abort(); render();
    }); actions.append(stop);
    const all = node('button', '下载全部图片'); all.hidden = true;
    all.addEventListener('click', () => {
      const state = inspection;
      if (state?.item.kind === 'album' && !state.busy) void startDownload(state.item, state.rows);
    }); actions.append(all);
    const zip = node('button', '下载为 ZIP'); zip.hidden = true;
    zip.title = '把已识别的图片和实况照片配对文件打包为一个 ZIP 压缩包保存';
    zip.addEventListener('click', () => {
      const state = inspection;
      if (state?.item.kind === 'album' && !state.busy) void startZipDownload(state.item, state.rows);
    }); actions.append(zip);
    const table = node('table'); const thead = node('thead'); const labels = node('tr');
    for (const label of ['档位', '分辨率', '真实大小', '']) labels.append(node('th', label));
    thead.append(labels); const rows = node('tbody'); table.append(thead, rows);
    const empty = node('p', undefined, 'hint');
    const diagnostics = node('details'); diagnostics.append(node('summary', '查看未成功的探测')); const errors = node('pre'); diagnostics.append(errors);
    const downloadArea = node('div', undefined, 'download'); const downloadMessage = node('p', '', 'hint');
    const bar = node('div', undefined, 'bar'); bar.hidden = true;
    const fill = node('div'); fill.className = 'fill'; bar.append(fill);
    const cancel = node('button', '取消下载'); cancel.addEventListener('click', () => {
      if (!download) return;
      download.cancelled = true; download.controller.abort();
    }); downloadArea.append(downloadMessage, bar, cancel);
    panel.append(head, status, title, actions, table, empty, diagnostics, downloadArea);
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3'); icon.append(path);
    const button = node('button', undefined, 'video-action');
    button.type = 'button'; button.title = '点击下载当前视频或图集，拖动调整位置'; button.setAttribute('aria-label', '下载当前视频或图集'); button.append(icon);
    const dragging = enableIconDragging(button, placePanel);
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (dragging.ignoreClick(event)) return;
      // 再次点击图标收起面板；拖动后的第一次点击不会误触发。
      if (!panel.hidden) { panel.hidden = true; return; }
      beginCurrentProbe();
      placePanel();
    });
    shadow.append(style, panel, button); document.documentElement.append(host);
    ui = { panel, button, heading, column: labels.firstElementChild, status, title, stop, all, zip, rows, empty, diagnostics, errors, downloadMessage, bar, fill, cancel };
    addEventListener('resize', placePanel);
    GM_registerMenuCommand('下载当前视频或图集', () => button.click());
    syncCurrent = () => {
      const work = currentWork();
      const id = currentId(work);
      const playback = work ? {
        element: work.element,
        source: work.element.tagName === 'VIDEO' ? work.video.currentSrc || work.video.src || work.video.querySelector('source')?.src || '' : '',
        id,
      } : null;
      const changed = playbackChanged(currentPlayback, playback);
      const identityChanged = id !== activeId;
      currentPlayback = playback;
      activeId = id;
      if (changed) {
        pendingProbe = null; notice = '';
        inspectController?.abort(); inspectController = null; inspection = null;
        panel.hidden = true;
      }
      if (work) {
        dragging.update(work);
        ui.button.hidden = false;
      } else {
        ui.button.hidden = true;
      }
      if (pendingProbe) {
        if (pendingProbe.deadline <= Date.now()) {
          pendingProbe = null;
          notice = '未能读取当前作品卡片的数据。请刷新抖音页面后重试。';
          render();
        } else {
          const item = items.get(id);
          if (item) {
            pendingProbe = null;
            void inspect(item);
          }
        }
      }
      if (changed || identityChanged) render();
    };
    captureEmbeddedData();
    setInterval(syncCurrent, 400); syncCurrent(); render();
  }

  if (document.documentElement) mount();
  else document.addEventListener('DOMContentLoaded', mount, { once: true });
})();
