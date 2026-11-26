"""CLI:  python -m musicviz analyze song.mp3 [--stems htdemucs_6s|htdemucs|htdemucs_ft|none] [--no-midi]
         python -m musicviz serve [--port 44100]"""
import argparse
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def main():
    ap = argparse.ArgumentParser(prog="musicviz")
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("analyze", help="analyse one or more audio files")
    a.add_argument("files", nargs="+")
    a.add_argument("--stems", default="htdemucs_6s", choices=["htdemucs_6s", "htdemucs", "htdemucs_ft", "none"])
    a.add_argument("--no-midi", action="store_true")
    a.add_argument("--no-melody", action="store_true")
    a.add_argument("--force", action="store_true")
    a.add_argument("--out", default=str(ROOT / "results"))
    s = sub.add_parser("serve", help="start the web UI")
    s.add_argument("--port", type=int, default=44100)
    s.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    if args.cmd == "analyze":
        from .pipeline import run
        for f in args.files:
            t = time.time()
            last = [""]

            def cb(p, msg):
                if msg != last[0]:
                    last[0] = msg
                print(f"  [{p*100:5.1f}%] {msg}", flush=True)
            rid = run(Path(f), Path(args.out), {"stems_model": args.stems, "transcribe": not args.no_midi,
                                               "melody": not args.no_melody}, cb, force=args.force)
            print(f"done {f} -> results/{rid}  ({time.time()-t:.1f}s)")
    else:
        import uvicorn
        uvicorn.run("musicviz.server:app", host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    sys.exit(main())
