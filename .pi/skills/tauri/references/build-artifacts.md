# Tauri 构建产物收集与命名（tauri references）

### 安装包收集与命名

`tauri build` 的产物默认散落在 `src-tauri/target/release/bundle/<类型>/` 下，不直接从该目录分发。构建完成后统一收集到与前端产物同级的专门目录（如 `app/dist/installers/`），并按下表重命名：

```text
{product}_{version}_{os}_{arch}.{ext}
```

| 平台 | 示例 |
| --- | --- |
| Windows NSIS | `linapp_0.1.0_windows_x64.exe` |
| Windows MSI | `linapp_0.1.0_windows_x64.msi` |
| Linux deb | `linapp_0.1.0_linux_amd64.deb` |
| macOS dmg | `linapp_0.1.0_macos_aarch64.dmg` |

规则：全小写、下划线分隔；`product` 取 `productName`（kebab 或小写无空格）；`os` 用 `windows`/`linux`/`macos`；arch 用 `x64`/`arm64`（Linux 包惯例 `amd64`）；updater 的 `latest.json` 与 `.sig` 签名文件随同平台安装包一并收集。同版本同平台多类型（exe 与 msi）共存时保留两者，命名仅扩展名不同。

收集脚本加入构建收尾（PowerShell 示例，参数按项目实际 product 与版本调整）：

```powershell
$bundle = "app/src-tauri/target/release/bundle"
$dest = "app/dist/installers"
New-Item -ItemType Directory -Force $dest | Out-Null
$product = "linapp"; $version = "0.1.0"
$map = @{ msi = "windows_x64"; nsis = "windows_x64"; deb = "linux_amd64"; appimage = "linux_amd64"; app = "macos_aarch64"; dmg = "macos_aarch64" }
Get-ChildItem $bundle -Recurse -File | Where-Object {
  $_.Extension -in ".msi", ".exe", ".deb", ".AppImage", ".dmg", ".app", ".sig", ".json"
} | ForEach-Object {
  $kind = $_.Directory.Name
  $tag = $map[$kind]
  if ($tag) { Copy-Item $_.FullName "$dest/${product}_${version}_$tag$($_.Extension)" -Force }
}
```

`app/dist/installers/` 属构建产物，纳入项目 `.gitignore`，不入库；GitHub Release 与 updater 上传直接取该目录。
