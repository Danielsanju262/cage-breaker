import http.server
import socketserver
import os
import sys

class NoCacheHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

def run_server(port=8080):
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    socketserver.TCPServer.allow_reuse_address = True
    try:
        with http.server.ThreadingHTTPServer(('127.0.0.1', port), NoCacheHTTPRequestHandler) as httpd:
            print(f"Server running at http://localhost:{port} (http://127.0.0.1:{port})", flush=True)
            httpd.serve_forever()
    except OSError as e:
        alt_port = 8081 if port == 8080 else 8080
        print(f"Port {port} in use, trying port {alt_port}...", flush=True)
        with http.server.ThreadingHTTPServer(('127.0.0.1', alt_port), NoCacheHTTPRequestHandler) as httpd:
            print(f"Server running at http://localhost:{alt_port} (http://127.0.0.1:{alt_port})", flush=True)
            httpd.serve_forever()

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    try:
        run_server(port)
    except KeyboardInterrupt:
        print("\nServer stopped.")

