export type GoogleUser = {
  // Google ID token, sent to the server as a bearer token
  credential: string;
  name: string;
  email: string;
  picture: string;
  // Expiry in ms, Google ID tokens last about an hour
  exp: number;
};

// OAuth client ID from the Google Cloud console, set in .env
export const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;

const storageKey = "googleCredential";

// Reads the profile from the token payload; the server does the real verification
export function parseCredential(credential: string): GoogleUser | null {
  try {
    const base64 = credential.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    return {
      credential,
      name: payload.name,
      email: payload.email,
      picture: payload.picture,
      exp: payload.exp * 1000,
    };
  } catch (e) {
    return null;
  }
}

export function loadStoredUser(): GoogleUser | null {
  const credential = localStorage.getItem(storageKey);
  const user = credential ? parseCredential(credential) : null;
  if (user && user.exp > Date.now()) {
    return user;
  }
  localStorage.removeItem(storageKey);
  return null;
}

export function storeUser(user: GoogleUser | null) {
  if (user) {
    localStorage.setItem(storageKey, user.credential);
  } else {
    localStorage.removeItem(storageKey);
  }
}

let gisPromise: Promise<void> | null = null;

// Loads the Google Identity Services script once
export function loadGis() {
  gisPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google sign-in"));
    document.head.appendChild(script);
  });
  return gisPromise;
}
