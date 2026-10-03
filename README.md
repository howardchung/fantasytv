## fantasytv

Custom webapp for managing reality TV fantasy leagues, with auto-scoring from scraping Wikipedia

### Google login

Login uses Firebase Authentication. In the [Firebase console](https://console.firebase.google.com/):

1. Create a project and add a web app
2. Under Authentication > Sign-in method, enable Google
3. Under Authentication > Settings > Authorized domains, add the domain you serve the app from (`localhost` is included by default)

Then add the web app's config to `.env`:

```
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=<project-id>.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=<project-id>
VITE_FIREBASE_APP_ID=...
FIREBASE_PROJECT_ID=<project-id>
```

The `VITE_` values are used by the client; `FIREBASE_PROJECT_ID` is used by the server to verify sign-in tokens.
