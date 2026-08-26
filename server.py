import http.server
import socketserver
import os
import sys

DIRECTORY = os.path.dirname(os.path.abspath(__file__))

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

def run_server(port=8080):
    socketserver.TCPServer.allow_reuse_address = True
    for p in [port, 8081, 8082, 3000, 5000]:
        try:
            with socketserver.TCPServer(("", p), NoCacheHandler) as httpd:
                print(f"Server running at http://localhost:{p} (http://127.0.0.1:{p})", flush=True)
                httpd.serve_forever()
                break
        except OSError:
            print(f"Port {p} is in use, trying next port...", flush=True)

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    try:
        run_server(port)
    except KeyboardInterrupt:
        print("\nServer stopped.")
