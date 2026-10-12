# 发布到 GitHub 与 Greasy Fork

## GitHub

仓库建议命名为 `douyin-userscript`。本目录已经初始化为独立 Git 仓库。

1. 在 GitHub 创建一个新的空仓库，名称可以使用 `douyin-userscript`。使用本地 Git 上传时，不要让 GitHub 额外生成 README、许可证或 `.gitignore`，以免产生两套初始提交。
2. 在这个目录打开终端，按 GitHub 创建仓库后显示的提示添加远程地址：

   ```bash
   git remote add origin <GitHub 提供的仓库地址>
   git push -u origin main
   ```

也可以使用 GitHub 网页「Upload files」，上传本目录根部的三个文件：用户脚本、README.md、PUBLISH.md。

## Greasy Fork

1. 登录 [Greasy Fork](https://greasyfork.org/zh-CN)，进入[发布脚本](https://greasyfork.org/zh-CN/scripts/new)。
2. 复制 `douyin-quality-downloader.user.js` 的全部内容，连同顶部声明一起粘贴。
3. 按自己的署名及授权意愿补充 `@author`、`@license`。如果选用 MIT，在脚本声明添加 `// @license MIT`，并在 GitHub 仓库加入相同许可证的 LICENSE 文件。本次拆分保留原脚本元数据，没有代选许可证。
4. 填写中文介绍并发布；README 中的功能、安装与使用说明可以作为介绍材料。

可使用这段简短介绍：

> 在抖音推荐页、关注页和视频详情页，点击下载图标，自动获取当前视频的可用画质、实际分辨率和文件大小，并选择下载。图标支持拖动和位置记忆；文件名自动清理特殊字符并限制长度。使用前请登录抖音网页版，安装后刷新页面。适用于桌面 Chrome / Edge 和 Tampermonkey。

发布后，将 Greasy Fork 的安装页面链接加到 GitHub README 中，方便用户一键安装。不要添加尚未存在的 `@updateURL` 或 `@downloadURL`。

## 后续更新

1. 在本仓库修改用户脚本，并递增顶部的 `@version`，例如从 `0.1.6` 改为 `0.1.7`。
2. 检查语法：

   ```bash
   node --check douyin-quality-downloader.user.js
   ```

3. 在浏览器保存更新后的脚本，刷新抖音，验证当前视频探测、下载及拖动。
4. 提交并上传 GitHub，在同一个 Greasy Fork 脚本页面提交新版本，保持 `@name` 和 `@namespace` 稳定。

通过 Greasy Fork 安装后，后续更新由油猴按其更新设置检查。首次从手动粘贴改为 Greasy Fork 安装时，确认只保留一份启用的脚本。
