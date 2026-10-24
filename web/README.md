# File vault UI

Local Next.js app for uploading objects and reading older versions from `s3-file-vault-399352912234`.

The page signs in with Cognito and calls API Gateway. Set `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_COGNITO_CLIENT_ID`, and `NEXT_PUBLIC_AWS_REGION` in `.env.local`.

```bash
cd web
npm run dev
```

Open http://127.0.0.1:3000. Store the same file name twice, then open the earlier version ID.
