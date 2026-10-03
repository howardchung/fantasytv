## fantasytv

Custom webapp for managing reality TV fantasy leagues, with auto-scoring from scraping Wikipedia

### Google login

Login uses [Sign in with Google](https://developers.google.com/identity/gsi/web). In the [Google Cloud console](https://console.cloud.google.com/apis/credentials):

1. Create an OAuth client ID of type "Web application"
2. Under Authorized JavaScript origins, add every origin you serve the app from. For local development add both `http://localhost` and `http://localhost:5173`

Then add the client ID to `.env`:

```
VITE_GOOGLE_CLIENT_ID=<client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_ID=<client-id>.apps.googleusercontent.com
```

`VITE_GOOGLE_CLIENT_ID` is used by the client; `GOOGLE_CLIENT_ID` is used by the server to verify sign-in tokens.
