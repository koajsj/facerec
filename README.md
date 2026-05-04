# 人脸识别项目结构

本项目按三层结构组织：

- `shared-src`：共享源码（含独立算法文件 `face-algorithm.js`）
- `local-dev`：本地运行版
- `gh-pages`：GitHub Pages 发布版

## 同步命令

```powershell
cd C:\Users\Administrator\Desktop\人脸识别
powershell -ExecutionPolicy Bypass -File .\scripts\sync.ps1
```

## 本地运行

```powershell
cd C:\Users\Administrator\Desktop\人脸识别\local-dev
py -m http.server 5600
```

打开 `http://localhost:5600`。

## 发布

将 `gh-pages` 目录推送到仓库 `main` 分支后，GitHub Pages 使用根目录部署。
