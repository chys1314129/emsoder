"""
用法: python3 wxpublic_fetch.py <output_dir> <url1> [url2 ...]

并发抓取微信公众号文章：
  - url2md 转换：5 线程
  - 图片下载：每篇 8 线程
"""

import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import sys

IMG_EXTS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg"}
IMG_PATTERN = re.compile(r"https?://[^\s\)\"']+")


def is_image_url(url):
    u = url.split("?")[0].lower()
    return (
        "anything-md-images.doocs.org" in u
        or "mmbiz.qpic.cn" in u
        or any(u.endswith(ext) for ext in IMG_EXTS)
    )


def safe_filename(name):
    name = re.sub(r'[/\\:*?"<>|]', "_", name)
    return name.strip() or "article"


def unique_path(base_dir, name, ext=".md"):
    p = os.path.join(base_dir, name + ext)
    i = 2
    while os.path.exists(p):
        p = os.path.join(base_dir, f"{name}_{i}{ext}")
        i += 1
    return p


def img_filename(img_url):
    path = img_url.split("?")[0].rstrip("/")
    base = path.split("/")[-1] or hashlib.md5(img_url.encode()).hexdigest()[:8]
    if not any(base.lower().endswith(ext) for ext in IMG_EXTS):
        base += ".jpg"
    return base


def download_image(img_url, images_dir):
    fname = img_filename(img_url)
    dest = os.path.join(images_dir, fname)
    if os.path.exists(dest) and os.path.getsize(dest) > 0:
        return fname
    subprocess.run(
        ["curl", "-s", "-L", "--max-time", "30", "-o", dest, img_url],
        capture_output=True,
    )
    return fname if (os.path.exists(dest) and os.path.getsize(dest) > 0) else None


def fetch_and_save(url, output_dir):
    try:
        r = subprocess.run(
            [
                "curl", "-s", "--max-time", "60",
                "-X", "POST", "https://anything-md.doocs.org/",
                "-H", "Content-Type: application/json",
                "-d", json.dumps({"url": url}),
            ],
            capture_output=True,
            text=True,
            encoding='utf-8', 
            timeout=65,
        )
        data = json.loads(r.stdout)
    except Exception as e:
        return url, False, f"请求失败: {e}", None

    if not data.get("success"):
        return url, False, "API 返回 success=false", None

    markdown = data.get("markdown", "")
    name_raw = re.sub(r"\.html?$", "", data.get("name", ""), flags=re.I)
    fname_base = safe_filename(name_raw) or url.split("/")[-1][:50]

    images_dir = os.path.join(output_dir, "images")
    os.makedirs(images_dir, exist_ok=True)

    img_urls = list(
        dict.fromkeys(u for u in IMG_PATTERN.findall(markdown) if is_image_url(u))
    )
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as img_ex:
        img_futures = {img_ex.submit(download_image, u, images_dir): u for u in img_urls}
        for f in concurrent.futures.as_completed(img_futures):
            orig_url = img_futures[f]
            local_name = f.result()
            if local_name:
                markdown = markdown.replace(orig_url, f"./images/{local_name}")

    dest_path = unique_path(output_dir, fname_base)
    with open(dest_path, "w", encoding="utf-8") as fh:
        fh.write(markdown)
    return url, True, None, dest_path


def main():
    if len(sys.argv) < 3:
        print("用法: python3 wxpublic_fetch.py <output_dir> <url1> [url2 ...]")
        sys.exit(1)

    output_dir = sys.argv[1]
    urls = sys.argv[2:]
    os.makedirs(os.path.join(output_dir, "images"), exist_ok=True)

    total = len(urls)
    saved, failed = [], []

    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as ex:
        future_map = {ex.submit(fetch_and_save, u, output_dir): u for u in urls}
        done = 0
        for f in concurrent.futures.as_completed(future_map):
            done += 1
            url, ok, err, path = f.result()
            if ok:
                saved.append(path)
                print(f"[{done}/{total}] ✓ {path}", flush=True)
            else:
                failed.append((url, err))
                print(f"[{done}/{total}] ✗ {url[:60]} — {err}", flush=True)

    print(f"\n成功: {len(saved)} 篇，失败: {len(failed)} 篇")
    for p in saved:
        print(f"SAVED:{p}")
    for u, e in failed:
        print(f"FAILED:{u} | {e}")


if __name__ == "__main__":
    main()
