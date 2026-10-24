# 小说专用运行包体积复评

alpha.23开发切片。官方SDK客户端和CLI仍固定0.2.1-rc.2，上游桌面源文件不改；使用官方sdk-minimal及现有novel.patch.yml，小说工具白名单不变。不另造Agent启动器，不编辑node_modules或删除旧版本。

alpha.22完整运行目录875文件约863.27 MiB；只读归档EXE的内置Node遍历实际ASAR得到28273逻辑文件、512202970字节（含解包项，不是物理总量），asar摘要139af095d1801713e06a075a6fec3083e518f47053a5f5d1a7b586c9d042eaa0。libreoffice-kit-win32-x64约190868660字节、sherpa-onnx-win-x64约23452212、inspector约23445353、lucide-react约20956099、文档预览约14698106。不能把源码依赖总数当成有效功能或全部运行必需资源。

官方sdk-minimal的cordis.patch.yml是独立完整配置，不继承dsh-base；无office、voice、inspector或client-ui条目。SDK客户端本身仍直接依赖完整dsh，直接删包或替换启动器会改变官方解析/退出与版本约束，因此此切片只按明确资源模式筛选构建输出，保留包清单、Node加载代码和许可文字。所有依赖存在检查仍开启；这不是完整通用dsh分发，未来启用某个相关能力必须重新评估对应资源。主应用PDF继续内置Chromium，不走LibreOffice。

plan/runtime-resource-exclusions.json作为构建/检查共享清单，排除未启用的Windows办公bin/program、语音native、调试器devtools以及选定通用桌面文档/账号/翻译客户端资源；保留原生图像libvips、完整官方Agent/SDK代码和许可证。verify-package.mjs按全逻辑文件验证没有命中排除模式，另外核对已知大资源不存在、包元信息仍在、依赖仍可在应用内解析；inventory明确只排除部分资源，不声称各上游包完整未改分发。

CodeMirror、React、ReactDOM和lucide只从apps/workbench导入，前端已由esbuild完整打入app.js，改列开发构建依赖，避免重复作为主进程运行包。锁文件只移动这六项分类，版本和解析未改；冻结安装检查通过。不能据此声称裁剪已安全，仍须新包实际启动、官方Agent流式与小说工具、图像、地图/地图册、PDF、安装/重装/卸载及旧版升级验证。

alpha.22完整包保留作为恢复对照；只新建alpha.23构建目录。先测实际体积/哈希和不可达资源，再决定是否继续，所有未通过检查保留。字体许可、全部分发审计、自动升级与产品完整上架仍未完成。
