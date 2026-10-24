# 原生图像组件来源核对

固定 npm sharp/@img 0.35.5 的源码提交为51a990faa26ade5586a4934ac9673c98d8893326，Windows DLL版本vips8.18.7。保留build-win64-mxe v8.18.7 README及Git对象SHA，包含web构建依赖版本、源码仓库和许可证表。该表的all构建附加组件不作为本包包含证明。

另保留sharp-libvips固定提交de4cb2b83409512ab62efacb8d7c32e00c054226的Windows配方和versions.properties，证明其按VERSION_VIPS下载build-win64-mxe web静态构建。它是研究时的配方快照；部分组件版本已比v8.18.7构建表更新，不能声称是已发布DLL可逐字节重现的准确构建环境。未运行配方、未下载或保留ZIP。

本机实际打包探针核对app-local sharp加载、三格式处理、DLL可读写和许可证原始SHA；这不替代所有传递依赖的完整源代码对应、重链接实验或商店认证。发布前完整分发审计仍属于稳定版门槛。
