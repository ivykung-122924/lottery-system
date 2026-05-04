# Google Cloud 直接部署（不經 Railway / Git）

這份專案可以直接用 `gcloud` 從本機部署到 Cloud Run。

## 1) 先決條件

- 已安裝 [Google Cloud SDK](https://cloud.google.com/sdk/docs/install)
- 已登入：
  - `gcloud auth login`
  - `gcloud auth application-default login`
- 已建立 GCP 專案（以下用 `YOUR_PROJECT_ID`）

## 2) 設定專案與 API

```bash
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

## 3) 建立 GCS Bucket（存 banner / 上傳資料快照）

```bash
gsutil mb -l asia-east1 gs://YOUR_BUCKET_NAME
```

> 建議 bucket 名稱全球唯一，例如 `lottery-system-xxx`.

## 4) 權限（Cloud Run 預設服務帳號可寫入 bucket）

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:YOUR_PROJECT_NUMBER-compute@developer.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

## 5) 直接從本機部署（不用 Git）

在專案根目錄執行：

```bash
gcloud run deploy lottery-system \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --set-env-vars ADMIN_PASSWORD=請改成強密碼,GCS_BUCKET=YOUR_BUCKET_NAME,GCS_UPLOAD_PREFIX=lottery-system
```

## 6) 驗證

- 健康檢查：`https://<cloud-run-url>/health`
- API 健康：`https://<cloud-run-url>/api/health`

## 7) 重要限制（目前版本）

- 目前主要資料仍使用 sqlite 檔案（`app.sqlite`），在 Cloud Run 屬於暫存磁碟，重啟可能遺失。
- 這次修改已把 **banner 與 latest.json** 支援到 GCS，解決「上傳檔不落地」問題。
- 若你要正式長期上線，下一步建議把 sqlite 移到 Cloud SQL(PostgreSQL)。
