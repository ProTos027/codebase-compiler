import os
import sys
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()
def main() -> int:
    target = None
    if len(sys.argv) > 1:
        target = sys.argv[1]
    if not target:
        target = os.environ.get("loc")

    path = Path(target).expanduser().resolve()
    if not path.exists():
        print(f"Path not found: {path}")
        return 1

    if path.is_file():
        print(f"FILE {path} ({path.stat().st_size} bytes)")
        return 0

    for entry in sorted(path.iterdir(), key=lambda p: p.name.lower()):
        if entry.is_dir():
            print(f"DIR  {entry}")
        else:
            size = entry.stat().st_size
            print(f"FILE {entry} ({size} bytes)")

    return 0

if __name__ == "__main__":
    raise SystemExit(main())
