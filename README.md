# 人脸追踪网页项目

## 目录结构

- `shared-src`：共享源码（主维护目录）
- `local-dev`：本地运行版
- `gh-pages`：GitHub Pages 发布版
- `scripts/sync.ps1`：将共享源码同步到本地版和发布版

## 当前功能（精简版）

- 摄像头实时人脸检测与绿色方框跟随
- 方框覆盖范围扩大（更接近整脸）
- 跟随速度优化（响应更快）
- 双模型切换：
  - `检测器`（BlazeFace，性能优先）
  - `关键点`（Face Landmarker，支持事件）
- 事件显示（关键点模式）：
  - `blink`：眨眼
  - `mouth_open`：张嘴
- 截图功能
- 主题切换

## 界面说明

- 主界面仅保留 3 个按钮：
  - `开始/停止`
  - `模式切换`
  - `工具`
- 工具面板中保留：
  - `截图`
  - `主题`

## 已做质量修复

- 修复中文乱码文案
- 修复启动并发问题（连续点击导致状态错乱）
- 修复模式切换时机问题（运行中禁止切换）
- 修复置信度不变化问题（更新更灵敏，显示 1 位小数）
- 移除延迟显示

## 本地运行

```powershell
cd C:\Users\Administrator\Desktop\人脸识别
powershell -ExecutionPolicy Bypass -File .\scripts\sync.ps1

cd C:\Users\Administrator\Desktop\人脸识别\local-dev
py -m http.server 5600
```

浏览器打开：`http://localhost:5600`

## GitHub Pages

仓库：`https://github.com/koajsj/facerec`

Pages 设置：
- `Settings -> Pages`
- `Deploy from a branch`
- 分支 `main`
- 目录 `/ (root)`

访问地址：`https://koajsj.github.io/facerec/`
