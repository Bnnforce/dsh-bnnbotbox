# 参与开发

## 跑测试

```bash
pnpm install --prod=false
node test/run-all.mjs          # 主入口 + 启动冒烟
node test/install/fresh-env.mjs # 空环境能跑
```

## 代码风格

- **ESM**（`.js` + `export`），不用 CommonJS
- 文件头写清「为什么要有这个文件」，不是「这个文件做什么」
- 不写没用的注释，但**踩过的坑一定要写**（下次有人会再踩）

## 改代码改哪个目录（重要）

本仓库**只有 `lib/*.js` 一个源码目录**，无构建：

- **改 `lib/*.js` 立即生效**（重启 DSH）。
- 2026-11-25 起，早期 TypeScript 迁移残留的 `src/` 已删除——它无 tsconfig、无 build、不在 `files`、且内部断链不可编译，是纯负担。
- 所以**改 `lib/*.js` 就是改代码本身**，没有「编译」这一说。

## 提 PR

1. 一个 PR 只做一件事
2. 改了行为就加测试
3. 如果改了配置字段，**同步改 `lib/persona/config.js` 和 `lib/memory/config.js` 两处**（schema + resolveConfig）

## 不要做的事

- 不要往 `dist/` 或 `node_modules/` 里改东西（升级就丢）
- 不要引入需要编译的依赖（Android 上装不动）
- 不要加出网请求
