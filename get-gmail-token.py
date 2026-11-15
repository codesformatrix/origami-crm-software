#!/usr/bin/env python3
"""
Get a Gmail OAuth refresh token - no local server needed.

Requirements: Python 3.6+

Flow:
1. Script prints an auth URL
2. Open it in your browser, pick your Google account, click Allow
3. Google redirects to http://127.0.0.1:39999/callback?code=... (page won't load)
4. Copy the FULL address from the browser address bar
5. Paste it back into the terminal when prompted
6. Script exchanges it for a refresh token and prints it
"""

import urllib.parse
import urllib.request
import sys
import os
import json

CLIENT_ID = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
if not CLIENT_ID or not CLIENT_SECRET:
    print("ERROR: Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET env vars")
    print("Example:")
    print("  export GOOGLE_OAUTH_CLIENT_ID='your-client-id.apps.googleusercontent.com'")
    print("  export GOOGLE_OAUTH_CLIENT_SECRET='your-client-secret'")
    print("  python3 get-gmail-token.py")
    sys.exit(1)

REDIRECT_URI = "http://127.0.0.1:39999/callback"
SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.metadata",
]

def main():
    print("\n" + "=" * 60)
    print("  Gmail OAuth Refresh Token Helper (No Server)")
    print("=" * 60)

    auth_url = "https://accounts.google.com/o/oauth2/v2/auth"
    params = urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",
        "prompt": "consent",
    })
    full_url = f"{auth_url}?{params}"

    print(f"\n📋 Copy this URL and open it in your browser:\n")
    print(f"  {full_url}\n")
    print(f"\nSteps:")
    print(f"  1. Open the URL above in your browser")
    print(f"  2. Pick your Google account (aliasgar982692@gmail.com)")
    print(f"  3. Click 'Allow' on the permission screen")
    print(f"  4. You'll be redirected to a page that won't load")
    print(f"  5. Copy the FULL address from the browser address bar")
    print(f"  6. Come back here and paste it\n")

    redirect_url = input("Paste the full browser address here: ").strip()

    if not redirect_url:
        print("\n❌ No URL provided.")
        sys.exit(1)

    # Parse the code from the redirect URL
    parsed = urllib.parse.urlparse(redirect_url)
    qparams = urllib.parse.parse_qs(parsed.query)

    code = qparams.get("code", [None])[0]
    error = qparams.get("error", [None])[0]

    if error:
        print(f"\n❌ Google returned error: {error}")
        desc = qparams.get("error_description", [""])[0]
        if desc:
            print(f"   {desc}")
        sys.exit(1)

    if not code:
        print("\n❌ No authorization code found in the URL.")
        print("   Make sure you pasted the FULL address including ?code=...")
        print(f"\n   The URL should start with: {REDIRECT_URI}?code=")
        sys.exit(1)

    print(f"\n🔄 Code captured! Exchanging for tokens...\n")

    token_data = urllib.parse.urlencode({
        "code": code,
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    }).encode()

    req = urllib.request.Request(
        "https://oauth2.googleapis.com/token",
        data=token_data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )

    try:
        with urllib.request.urlopen(req) as resp:
            tokens = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = e.read().decode()
        print(f"\n❌ Token exchange failed (HTTP {e.code}): {body}")
        sys.exit(1)

    if "error" in tokens:
        print(f"\n❌ Token exchange failed: {tokens.get('error_description', tokens['error'])}")
        sys.exit(1)

    refresh_token = tokens.get("refresh_token", "")
    print("\n" + "=" * 60)
    print("  ✅ SUCCESS!")
    print("=" * 60)
    print(f"\n  REFRESH_TOKEN: {refresh_token}")
    print(f"\n  Copy this token and paste it into the CRM:")
    print(f"  Settings → Gmail → 'Or paste an OAuth refresh token'")
    print(f"  → paste → Save & Connect\n")

if __name__ == "__main__":
    main()
