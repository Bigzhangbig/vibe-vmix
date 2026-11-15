# 转播包装 · Live Bridge

连接 Windows 上支持 CEP 的 After Effects 和转播包装工作台。

1. 退出 AE，在插件目录运行 `powershell -ExecutionPolicy Bypass -File .\安装插件.ps1 -EnableUnsignedExtensions`。该选项允许加载未签名 CEP 扩展。
2. 启动 AE，在「首选项 → 脚本与表达式」启用「允许脚本写入文件和访问网络」，再从「窗口 → 扩展」打开 Live Bridge。
3. 在工作台启用「AE 直播连接」，把模块提供的连接地址和配对密钥填入插件，选中合成并连接。

用 `LIVE:` 标记文字、滑块、颜色和开关控件。点击「持续生成当前画面」刷新预览。要播放动画，渲染 AE 工作区，再将生成的缓存添加到 vMix。

## 导入 AE 工程和合成

只用舞台模块离线渲染时，不需要安装 CEP 插件。先链接或导入 `.aep` / `.aepx`，再在 AE 打开同一工程，从「文件 → 脚本 → 运行脚本文件」执行 [export-compositions.jsx](jsx/export-compositions.jsx)。如果只需要几个合成，先在 AE 项目面板选中它们；不选合成则导出整个项目的合成清单。保存 JSON 后，在舞台模块给已关联的 AE 工程导入该清单，也可以直接填合成名。

渲染时请选择本机实际存在的 AE 输出模块：PNG 序列用 PNG + RGB + Alpha；透明 MOV 用 QuickTime + Apple ProRes 4444 + RGB + Alpha。建议使用直通 Alpha（Straight / Unmatted）。输出模块模板名因语言和安装设置而异。工程的素材、字体和效果仍由 AE 读取，不会转成网页内置模板。

本版本未完全验证，可能存在BUG，如遇BUG请与开发者联系
