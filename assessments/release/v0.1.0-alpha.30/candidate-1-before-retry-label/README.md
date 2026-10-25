# 中间候选：不可继承为最终alpha.30资格

这是重试模型提示修改之前的d75713b应用，后续70cd8a5仅修QA。实际安装EXE SHA `42aa7d0f5425f6d83dc545905b76c49c4deea468906a499b3f61d81c7ac05e46`，asar `804afd1cd5a84abab4bf2d9fa689749b455fefecc7b0cbd6cb325f55c58897f2`。首轮备份探针等待失败另存相邻目录；修QA后第二轮完整167项通过，安装9821ms/重装15320ms/卸载4663ms，alpha.3覆盖升级16829ms通过，旧合成原稿/任务/设置保留。

之后c8a6f68修改了应用：历史重试说明新增当前模型，并在选择未就绪时禁用重试。因此上述本机通过只证明此中间候选，不能用于较新应用的preview-ready=true或标签。新候选重新打包、实际安装/升级和独立CI。此前自动生成manifest恰在主分支已前移后执行，其commit字段不能作为这个中间候选的生产源码证明；故不采用该manifest作为资格，原始文件留D盘供追踪。

实际D盘完整运行目录、EXE及原始报告：`D:\zinovel-releases\v0.1.0-alpha.30\candidate-1-before-retry-label`，没有ZIP。移动前核对asar与两个绝对路径分别在明确release源及此归档目标内；没有递归删除。原始QA目录可能保留历史失败截图，只以逐项报告和本说明为准。
