# 人脸识别网页项目

## 目录结构

- `shared-src`：共享源码（主维护目录）
- `local-dev`：本地运行版
- `gh-pages`：GitHub Pages 发布版
- `scripts/sync.ps1`：将共享源码同步到两个版本目录

## 主要功能

- 摄像头实时检测人脸并绘制跟随方框
- 双模型可切换：
  - `BlazeFace Detector`（高性能）
  - `Face Landmarker`（支持眨眼/张嘴事件）
- 单人/多人模式
- 动态平滑 + IoU 关联跟踪 + TTL 防闪烁
- 截图导出、JSON 导出
- 极简科技风 UI，主界面仅 `Start/Stop`，高级操作收纳在 `Tools`

## 事件检测

在 `Face Landmarker` 模式下，系统会在 `Events` 一栏显示：

- `blink`：检测到眨眼
- `mouth_open`：检测到张嘴

## 运行方式

### 1) 同步代码

```powershell
cd C:\Users\Administrator\Desktop\人脸识别
powershell -ExecutionPolicy Bypass -File .\scripts\sync.ps1
```

### 2) 本地运行

```powershell
cd C:\Users\Administrator\Desktop\人脸识别\local-dev
py -m http.server 5600
```

浏览器打开：`http://localhost:5600`

### 3) GitHub Pages

仓库：`https://github.com/koajsj/facerec`

在仓库 `Settings -> Pages` 中选择：
- `Deploy from a branch`
- 分支 `main`
- 目录 `/ (root)`

访问地址：`https://koajsj.github.io/facerec/`
