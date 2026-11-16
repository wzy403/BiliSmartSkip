# BiliSmartSkip 测试分支

这个分支只放测试和离线评测工具，不含扩展代码。运行时指定要测的分支，脚本会把它的 `scr/` 和 `manifest.json` 导出到临时目录再测：

```sh
git checkout test-branch
node run-tests.cjs master   # 换成要测的分支；不写则测切过来之前所在的分支
```

- `tests/`：功能回归，见 [tests/README.md](tests/README.md)
- `eval/`：离线评测和词表生成，见 [eval/README.md](eval/README.md)

不要把这个分支合并回 master，也不需要把 master 合并进来。
