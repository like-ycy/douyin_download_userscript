// ==UserScript==
// @name         抖音画质探测与下载
// @namespace    douyin-quality-downloader
// @version      0.2.0
// @description  下载当前作品：视频画质探测、图集逐张或整组保存。
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

  function rememberItem(value) {
    const id = workId(value?.aweme_id) || workId(value?.awemeId);
    if (!id) return;
    // 详情 API 为 snake_case；推荐页 RSC / 卡片数据为 camelCase。
    const urls = list => Array.isArray(list) ? list.map(entry => typeof entry === 'string' ? entry : entry?.src).filter(url => typeof url === 'string') : [];
    const images = Array.isArray(value.images) ? value.images.map((image, index) => ({
      index: index + 1, width: image?.width || 0, height: image?.height || 0,
      urls: urls(image?.url_list || image?.urlList).map(mediaUrl).filter(Boolean),
    })) : [];
    const album = images.length > 0 || Number(value.aweme_type ?? value.awemeType) === 68;
    const video = value.video;
    let normalizedVideo = null;
    if (!album) {
      if (!video) return;
      const address = video.play_addr || {
        uri: video.uri, url_list: urls(video.playAddr), width: video.width, height: video.height,
      };
      if (typeof address.uri !== 'string' || !address.uri) return;
      const rates = Array.isArray(video.bit_rate) ? video.bit_rate : (Array.isArray(video.bitRateList) ? video.bitRateList : []).map(rate => ({
        bit_rate: rate.bitRate, is_h265: rate.isH265,
        play_addr: { uri: rate.uri, url_list: urls(rate.playAddr), width: rate.width, height: rate.height },
      }));
      normalizedVideo = { play_addr: address, bit_rate: rates, is_h265: video.is_h265,
        play_addr_h264: video.play_addr_h264,
        play_addr_265: video.play_addr_265 || { uri: video.uri, url_list: urls(video.playAddrH265), width: video.width, height: video.height } };
    }
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
      if (result) state.rows.push({ ...result, kind: 'image', index: image.index,
        label: `图片 ${image.index}`, width: image.width, height: image.height });
      else state.errors.push(`图片 ${image.index}：${errorMessage}`);
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

  function filename(item, row) {
    const author = clipFilename(cleanFilenamePart(item.author?.nickname), 20, 60);
    const title = cleanFilenamePart((item.desc || '').replace(/#[^\s#]+/g, '').replace(/#/g, ''));
    let base = author && title ? `${author} - ${title}` : title || `douyin_${workId(item.aweme_id) || 'video'}`;
    // Windows 设备名带扩展名也保留；清洗后再次保证不会成为设备名。
    if (/^(CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(base)) base = `_${base}`;
    const validDimension = value => Number.isSafeInteger(value) && value > 0 && value <= 65535;
    const quality = row.ratio === 'default' ? 'default'
      : validDimension(row.width) && validDimension(row.height) ? `${row.width}x${row.height}` : '未知尺寸';
    const codec = clipFilename(cleanFilenamePart(row.codec), 16, 32);
    const suffix = row.kind === 'image'
      ? ` - 图片${String(row.index).padStart(3, '0')}.${row.extension}`
      : ` - ${quality}${codec ? ` ${codec}` : ''}.mp4`;
    // 整个文件名（含画质后缀和扩展名）同时限制 UTF-16 长度与 UTF-8 字节数。
    const budget = 200 - new TextEncoder().encode(suffix).length;
    base = clipFilename(base, 120 - suffix.length, budget) || 'douyin_video';
    return base + suffix;
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
        // Chrome 下载 API 禁止 User-Agent；由油猴取回单个文件后交给浏览器保存。
        state.transfer = GM_xmlhttpRequest({
          method: 'GET', url: resolved.url, timeout: 120000, responseType: 'blob',
          headers: { 'User-Agent': MOBILE_UA, Referer: 'https://www.douyin.com/' },
          onprogress: options.onprogress,
          onload: response => {
            if (settled) return;
            if (response.status !== 200 || !(response.response instanceof Blob) || response.response.size === 0) {
              finish(new Error(`文件请求失败（HTTP ${response.status}）`)); return;
            }
            if (row.kind === 'image') {
              const extension = imageExtension(header(response, 'content-type') || response.response.type);
              if (!extension || !mediaUrl(response.finalUrl || resolved.url)) {
                finish(new Error('下载地址未返回允许的图片文件')); return;
              }
              resolved.extension = extension;
              state.name = filename(item, { ...row, extension });
            }
            state.total = response.response.size;
            state.loaded = response.response.size;
            render();
            save(response.response);
          },
          onerror: () => finish(new Error('文件传输失败，请重新探测后重试')),
          ontimeout: () => finish(new Error('文件传输超时，请重试')),
          onabort: () => finish(abortError()),
        });
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
    const waiting = Boolean(pendingProbe);
    ui.heading.textContent = album ? '抖音图集下载' : '抖音视频下载';
    ui.column.textContent = album ? '图片' : '档位';
    ui.stop.hidden = !state?.busy && !waiting;
    ui.all.hidden = !album || !state?.rows.length;
    ui.all.disabled = Boolean(download || state?.busy);
    ui.all.textContent = `下载${state?.rows.length === item?.images.length ? '全部' : '已识别'}图片（${state?.rows.length || 0} 张）`;
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
      if (row.codec) quality.append(node('small', `${row.codec}${row.bitrate ? ` · ${(row.bitrate / 1e6).toFixed(2)} Mbps` : ''}`));
      tr.append(quality, node('td', row.width && row.height ? `${row.width} × ${row.height}` : '未知'), node('td', humanSize(row.size)));
      const action = node('td');
      const button = node('button', '下载');
      button.disabled = Boolean(download);
      button.addEventListener('click', () => startDownload(item, row));
      action.append(button); tr.append(action); ui.rows.append(tr);
    }
    ui.diagnostics.hidden = !state?.errors.length;
    ui.errors.textContent = state?.errors.join('\n') || '';
    ui.empty.textContent = !state
      ? waiting ? '收到当前作品数据后会自动开始探测。' : '点击当前作品旁的下载图标开始探测。'
      : state.busy ? album ? '正在读取图片格式和文件大小……' : '正在读取当前视频的播放版本和文件大小……'
      : state.rows.length ? album ? '按图集顺序保存独立图片；尺寸来自作品数据，格式以文件响应为准。' : '重复直链已合并；分辨率未知时不会猜测画质。'
      : '当前作品未取得可下载文件，请检查登录状态和油猴跨域授权。';
    ui.cancel.hidden = !download;
    if (download) ui.downloadMessage.textContent = `${download.count > 1 ? `[${download.completed + 1}/${download.count}] ` : ''}${download.name}：${humanSize(download.loaded)} / ${humanSize(download.total)}`;
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
      table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}th,td{text-align:left;border-bottom:1px solid #383c49;padding:9px 4px}small{display:block;color:#9fa9bc;font-size:11px}
      .hint{color:#a7aebc;font-size:12px}pre{white-space:pre-wrap;font-size:12px;color:#eeb2bb}details{margin-top:8px}.download{border-top:1px solid #383c49;margin-top:12px;padding-top:8px}
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
    const table = node('table'); const thead = node('thead'); const labels = node('tr');
    for (const label of ['档位', '分辨率', '真实大小', '']) labels.append(node('th', label));
    thead.append(labels); const rows = node('tbody'); table.append(thead, rows);
    const empty = node('p', undefined, 'hint');
    const diagnostics = node('details'); diagnostics.append(node('summary', '查看未成功的探测')); const errors = node('pre'); diagnostics.append(errors);
    const downloadArea = node('div', undefined, 'download'); const downloadMessage = node('p', '', 'hint');
    const cancel = node('button', '取消下载'); cancel.addEventListener('click', () => {
      if (!download) return;
      download.cancelled = true; download.controller.abort();
    }); downloadArea.append(downloadMessage, cancel);
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
    ui = { panel, button, heading, column: labels.firstElementChild, status, title, stop, all, rows, empty, diagnostics, errors, downloadMessage, cancel };
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
