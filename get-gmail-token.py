#!/usr/bin/env python3
"""
Get a Gmail OAuth refresh token by running this on YOUR computer.

Requirements: Python 3.6+ (most computers have it)

Usage:
    export GOOGLE_OAUTH_CLIENT_ID='your-client-id.apps.googleusercontent.com'
    export GOOGLE_OAUTH_CLIENT_SECRET='your-client-secret'
    python3 get-gmail-token.py

It will:
1. Start a local server on port 39999
2. Open Google's consent screen in your browser
3. Capture the authorization code from the redirect
4. Exchange it for a refresh token
5. Print the refresh token for you to paste into the CRM

IMPORTANT: Before running, make sure:
- You've added yourself as a test user in Google Cloud Console
  (OAuth consent screen → Test users → + Add users → your email)
- You've enabled the Gmail API in your Google Cloud project
"""

import http.server
import webbrowser
import urllib.parse
import urllib.request
import sys
import os
import json

# Get credentials from environment variables
CLIENT_ID = os.environ.get("GOOGLE_OAUTH_CLIENT_ID", "")
CLIENT_SECRET = os.environ.get("GOOGLE_OAUTH_CLIENT_SECRET", "")
if not CLIENT_ID or not CLIENT_SECRET:
    print("ERROR: Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET env vars")
    print("Example:")
    print("  export GOOGLE_OAUTH_CLIENT_ID='your-client-id.apps.googleusercontent.com'")
    print("  export GOOGLE_OAUTH_CLIENT_SECRET='your-client-secret'")
    print("  python3 get-gmail-token.py")
    sys.exit(1)

REDIRECT_PORT = 39999
REDIRECT_URI = f"http://localhost:{REDIRECT_PORT}/callback"
SCOPES = [
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.metadata",
]

code_holder = {"code": None, "error": None}

class CallbackHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if parsed.path == "/callback":
            code = params.get("code", [None])[0]
            error = params.get("error", [None])[0]

            if error:
                code_holder["error"] = error
                desc = params.get("error_description", [""])[0]
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(
                    f"<html><body style='font-family:sans-serif;padding:40px'>"
                    f"<h2>Error</h2><p>{error}</p><p>{desc}</p>"
                    f"<p>Close this tab and go back to the terminal.</p></body></html>".encode()
                )
                self.server.shutdown()
                return

            if code:
                code_holder["code"] = code
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.end_headers()
                self.wfile.write(
                    b"<html><body style='font-family:sans-serif;padding:40px'>"
                    b"<h2>Authorization received!</h2>"
                    b"<p>You can close this tab and go back to the terminal.</p>"
                    b"</body></html>"
                )
                self.server.shutdown()
                return

        self.send_response(404)
        self.end_headers()

    def log_message(self, format, *args):
        pass  # suppress logs

def main():
    print("\n" + "=" * 60)
    print("  Gmail OAuth Refresh Token Helper")
    print("=" * 60)
    print(f"\nClient ID:    {CLIENT_ID}")
    print(f"Redirect URI: {REDIRECT_URI}")
    print("\nMake sure you've added yourself as a test user in Google Cloud Console:")
    print("  https://console.cloud.google.com/apis/credentials/consent")
    print("  → Test users → + Add users → your email")
    print("\nStarting local server...")

    server = http.server.HTTPServer(("localhost", REDIRECT_PORT), CallbackHandler)

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

    print(f"\nOpening Google consent screen in your browser...\n")
    try:
        webbrowser.open(full_url)
    except Exception:
        print("Could not open browser automatically. Copy this URL and open it manually:")
        print(full_url)

    print("Waiting for you to complete authorization...\n")
    server.handle_request()

    if code_holder["error"]:
        print(f"\n❌ Google returned error: {code_holder['error']}")
        print("   Make sure you are a test user and the Gmail API is enabled.")
        sys.exit(1)

    code = code_holder["code"]
    if not code:
        print("\n❌ No authorization code received.")
        sys.exit(1)

    print("\n🔄 Exchanging authorization code for tokens...\n")
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
