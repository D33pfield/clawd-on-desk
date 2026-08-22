# macOS Developer ID 签名与公证

Clawd on Desk 通过 GitHub Releases 直接分发，不走 Mac App Store。正式
macOS 版本需要用 `Developer ID Application` 证书签名，并由 Apple 公证。

Apple Developer Program 会员生效只是前提，不代表证书或 CI 凭据已经生成。
下面的一次性准备完成后，本机和 GitHub Actions 才能产出 Gatekeeper 可直接
放行的安装包。

## 安全边界

- `.p12` 同时包含证书和私钥；`.p8` 是 App Store Connect API 私钥。
- 不要把这些文件、Base64 内容或密码提交到仓库、Issue、PR、日志或聊天。
- `.p8` 只能下载一次。若怀疑泄露，立即在 Apple 后台吊销对应 API Key。
- 正式版本始终使用同一团队的 Developer ID 证书；不要使用第三方证书签名。

## 1. 生成 Developer ID Application 证书

### 创建 CSR

在用于保存私钥的 Mac 上操作：

1. 打开“钥匙串访问”（`/Applications/Utilities/Keychain Access.app`）。
2. 菜单选择“钥匙串访问 → 证书助理 → 从证书颁发机构请求证书”。
3. “用户电子邮件地址”填写 Apple Developer 账号邮箱。
4. “常用名称”填写便于识别的名字，例如 `Clawd Release Key`。
5. “CA 电子邮件地址”留空，选择“存储到磁盘”。
6. 保存生成的 `.certSigningRequest` 文件。

### 创建并安装证书

1. 打开 <https://developer.apple.com/account/resources/certificates/list>。
2. 点击 `+`，在 Software 下选择 **Developer ID**。
3. 选择 **Developer ID Application**，不要选择 Developer ID Installer、
   Apple Development 或 Apple Distribution。
4. 上传刚生成的 CSR，下载 `.cer`。
5. 双击 `.cer` 导入钥匙串。

导入后运行：

```bash
security find-identity -v -p codesigning
```

必须看到一项类似：

```text
Developer ID Application: <姓名> (<TEAM_ID>)
```

### 导出给 GitHub Actions 使用的 `.p12`

1. 在“钥匙串访问 → 登录 → 我的证书”中展开 Developer ID Application。
2. 确认它下面带有对应私钥。
3. 右键证书，选择“导出”，格式选 `.p12`。
4. 设置一个新的高强度导出密码；该密码只用于 CI 导入这份 `.p12`。

如果证书下面没有私钥，说明 CSR 不是在这台 Mac 上生成，不能用该证书签名。

## 2. 创建公证用 Team API Key

使用 **Team API Key**，不要使用 Individual API Key；Individual Key 不能用于
`notarytool`。当前锁定的 `@electron/notarize` 要求 Team Key 具有
**App Manager** 权限。

1. 打开 <https://appstoreconnect.apple.com/access/integrations/api>。
2. 如果尚未启用 API，先由 Account Holder 在 Users and Access → Integrations
   请求 App Store Connect API 访问。
3. 进入 Team Keys，点击 Generate API Key（或 `+`）。
4. 名称可填 `Clawd GitHub Release`，Access 选择 **App Manager**。
5. 生成后记录 **Issuer ID** 和 **Key ID**。
6. 下载 `AuthKey_<KEY_ID>.p8`；Apple 只允许下载一次。

Developer Team ID、Issuer ID 和 Key ID 是三个不同的值，不能混用。

## 3. 先在本机验证一次

把 Team API Key 存进本机钥匙串；命令会在线校验凭据：

```bash
xcrun notarytool store-credentials "clawd-notary" \
  --key "/绝对路径/AuthKey_<KEY_ID>.p8" \
  --key-id "<KEY_ID>" \
  --issuer "<ISSUER_ID>"
```

只构建当前常用的 Apple Silicon 版本进行首次验证：

```bash
APPLE_KEYCHAIN_PROFILE=clawd-notary \
  npx electron-builder --mac dmg:arm64 --publish never \
  -c.mac.identity="Developer ID Application"
```

构建结束后验证未打包和 DMG 内实际分发的 app：

```bash
codesign --verify --deep --strict --verbose=2 \
  "dist/mac-arm64/Clawd on Desk.app"
spctl --assess --type execute --verbose=4 \
  "dist/mac-arm64/Clawd on Desk.app"
xcrun stapler validate "dist/mac-arm64/Clawd on Desk.app"
```

预期 `spctl` 显示 `accepted`，来源为 `Notarized Developer ID`，`stapler`
显示 validation succeeded。首次正式发布前，还必须从 GitHub draft Release
通过浏览器重新下载 DMG，再做一次 Gatekeeper 双击启动验证。

## 4. 配置 GitHub Actions Secrets

进入仓库 Settings → Secrets and variables → Actions → New repository secret，
配置以下五项：

| Secret | 内容 |
|---|---|
| `CSC_LINK` | `.p12` 文件的 Base64 内容 |
| `CSC_KEY_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_API_KEY` | `.p8` 文件的 Base64 内容 |
| `APPLE_API_KEY_ID` | App Store Connect Team Key 的 Key ID |
| `APPLE_API_ISSUER` | App Store Connect 的 Issuer ID |

在 Mac 上可把文件编码后直接送进剪贴板，避免打印在终端：

```bash
base64 -i "/绝对路径/DeveloperIDApplication.p12" | pbcopy
base64 -i "/绝对路径/AuthKey_<KEY_ID>.p8" | pbcopy
```

每执行一条命令，立刻把剪贴板粘贴到对应 Secret。不要把编码结果保存进仓库。

工作流规则：

- 五项全部存在：构建 Developer ID 签名、公证并 stapled 的 app；CI 会挂载
  x64 和 arm64 两个最终 DMG，验证里面实际分发的 app。
- 五项全部不存在：只有手动 `workflow_dispatch` 可以走 ad-hoc 验证。
- 只配置一部分：立即失败并列出缺少的 Secret 名称，不打印 Secret 内容。
- 推送 `v*` tag：五项缺任何一项都失败，绝不生成 ad-hoc 官方版本。

## 5. 首次发布验证

1. 在 Actions 手动运行 `Build & Release`，不要先推正式 tag。
2. 确认 macOS job 的签名、公证、DMG 挂载验证和 updater metadata 全部通过。
3. 下载 `mac-installer` artifact，检查 x64、arm64 DMG 和 `latest-mac.yml`。
4. 在另一台 Mac 或干净浏览器下载 DMG，双击打开并拖入 Applications。
5. 确认无需在“隐私与安全”中手动放行，再执行：

```bash
spctl --assess --type execute --verbose=4 "/Applications/Clawd on Desk.app"
xcrun stapler validate "/Applications/Clawd on Desk.app"
```

6. 首次验证全部通过后，才按发布流程创建并推送正式 `v*` tag。

## 参考

- [Apple：创建 Developer ID 证书](https://developer.apple.com/help/account/certificates/create-developer-id-certificates/)
- [Apple：创建 CSR](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request)
- [Apple：公证 macOS 软件](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple：App Store Connect API](https://developer.apple.com/help/app-store-connect/get-started/app-store-connect-api)
- [Electron：代码签名](https://www.electronjs.org/docs/latest/tutorial/code-signing)
