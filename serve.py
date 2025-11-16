#!/usr/bin/env python3
"""
Simple static file server for local development.

Usage:
  python serve.py            # serves current folder on http://127.0.0.1:8000
  python serve.py --port 5173
  python serve.py --dir C:\path\to\folder
"""

import argparse
import contextlib
import functools
import os
import socket
import sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler


def find_free_port(preferred: int) -> int:
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        try:
            s.bind(("127.0.0.1", preferred))
            return preferred
        except OSError:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description="Serve static files for local development.")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on (default: 8000)")
    parser.add_argument(
        "--dir",
        type=str,
        default=".",
        help="Directory to serve (default: current directory)",
    )
    args = parser.parse_args()

    serve_dir = os.path.abspath(args.dir)
    if not os.path.isdir(serve_dir):
        print(f"Error: directory not found: {serve_dir}", file=sys.stderr)
        sys.exit(1)

    port = find_free_port(args.port)

    # Python 3.7+ supports 'directory' parameter on SimpleHTTPRequestHandler
    handler_cls = functools.partial(SimpleHTTPRequestHandler, directory=serve_dir)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler_cls)

    print(f"Serving '{serve_dir}' at http://127.0.0.1:{port}")
    print("Press Ctrl+C to stop.")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()


