"""
FAL gpt-image-2 brand imagery generator for kolm.

Set FAL_KEY or FAL_API_KEY in your environment before running this script.
Never hard-code provider keys in this repository.
"""
import os, sys, time, json, base64, threading, pathlib, traceback
import requests

KEY = os.environ.get("FAL_KEY") or os.environ.get("FAL_API_KEY")
if not KEY:
    raise SystemExit("Set FAL_KEY or FAL_API_KEY before running scripts/fal_generate_v6.py")
OUT = pathlib.Path(__file__).resolve().parents[1] / "public" / "img"
OUT.mkdir(parents=True, exist_ok=True)
GEN = OUT / "_generations"
GEN.mkdir(parents=True, exist_ok=True)

ENDPOINT = "https://queue.fal.run/fal-ai/gpt-image-2"

HEADERS = {
    "Authorization": f"Key {KEY}",
    "Content-Type": "application/json",
}

# Six renders. Each has (slug, size, prompt).
# Prompts target: monolithic, single periwinkle accent, deep midnight, editorial photography.
RENDERS = [
    (
        "v6-monolith",
        "landscape_16_9",
        "A single matte-black monolithic slab the size of a tombstone, photographed from a low angle in a vast dim concrete hall. "
        "Dust-soft volumetric light from a single overhead source. The slab is engraved with one micro-thin periwinkle (#7C8CFF) glowing seal "
        "near the top edge — a small geometric mark, no text, no letters. The seal emits a faint cool glow. "
        "Rich blacks (#0a0a0a) dominate. Architectural, sacred, monolithic. No people. No props. No text. "
        "Editorial fine-art photography, large-format film aesthetic, Lynchian gravity. "
        "Crisp focus on the slab, shallow falloff into a void. Negative space carries the frame.",
    ),
    (
        "v6-compile",
        "landscape_16_9",
        "A long horizontal exposure: ten thin vertical light beams of warm white converging into a single periwinkle (#7C8CFF) point of light "
        "that fuses into a small dense matte-black cube the size of a fist on a polished black plinth. "
        "The cube is the only solid object in frame; the beams are pure photons. Deep midnight (#0a0a0a) field. "
        "Cinematic dolly-zoom geometry. No text, no letters, no UI. "
        "Editorial product photography, monolithic, restrained, single accent of periwinkle.",
    ),
    (
        "v6-anatomy",
        "landscape_16_9",
        "A precision exploded-view illustration of a small black sealed artifact opened in cross-section — five horizontal paper-thin "
        "layers floating with knife-edge spacing, each a different microtexture (woven, etched, gridded, pierced, foil-stamped). "
        "One single periwinkle (#7C8CFF) thread runs vertically through all five layers like a binding stitch. "
        "Deep midnight (#0a0a0a) background. Studio macro photography, top-light, soft shadows. "
        "No text, no labels, no letters. Editorial restraint, watch-movement precision.",
    ),
    (
        "v6-verify",
        "landscape_16_9",
        "A macro photograph of a single matte-black wax seal pressed into deep-midnight paper, with one periwinkle (#7C8CFF) "
        "geometric mark embossed at its center — a tiny abstract glyph, not letters. The wax has a soft satin sheen. "
        "Light rakes from the upper left, casting long delicate shadow grain. "
        "Frame composition: the seal sits dead center, surrounded by an enormous field of texture-rich black paper. "
        "No text, no logo. Fine-art still life, museum-grade, contemplative.",
    ),
    (
        "v6-runtime",
        "landscape_16_9",
        "A black architectural diptych: on the left, a small handheld matte-black device the size of a phone; on the right, a "
        "continental landscape rendered as a mirrored matte-black slab ridge, both connected by a single thin glowing periwinkle (#7C8CFF) line. "
        "Both objects identical in surface material. Deep midnight (#0a0a0a) background. "
        "Editorial fashion-photography lighting, single key, deep shadows. "
        "No text, no UI, no people. Monolithic minimalism, the same artifact in two scales.",
    ),
    (
        "v6-horizon",
        "landscape_16_9",
        "An infinite horizon at twilight: a flat black mirror lake stretching to a vanishing line, where the water meets a vast "
        "deep-midnight sky. A single thin periwinkle (#7C8CFF) line of light traces the horizon — the only chromatic element. "
        "No moon, no stars, no land. Glassy, primordial stillness. "
        "Large-format landscape photography, contemplative scale, sublime. "
        "No text, no objects, no people. Pure geometry of black and one accent.",
    ),
]


def submit(slug: str, size: str, prompt: str):
    body = {
        "prompt": prompt,
        "image_size": size,
        "num_images": 1,
        "quality": "high",
        "moderation": "auto",
        "background": "transparent" if False else "auto",
    }
    r = requests.post(ENDPOINT, headers=HEADERS, json=body, timeout=60)
    r.raise_for_status()
    return r.json()


def wait(qresp, slug):
    status_url = qresp["status_url"]
    response_url = qresp["response_url"]
    deadline = time.time() + 600
    while time.time() < deadline:
        time.sleep(4)
        s = requests.get(status_url, headers=HEADERS, timeout=30).json()
        st = s.get("status")
        if st == "COMPLETED":
            return requests.get(response_url, headers=HEADERS, timeout=60).json()
        if st in ("FAILED", "CANCELLED"):
            raise RuntimeError(f"{slug}: {s}")
    raise TimeoutError(f"{slug}: did not finish in 600s")


def download(url: str, dest: pathlib.Path):
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    dest.write_bytes(r.content)
    return len(r.content)


def run_one(slug: str, size: str, prompt: str):
    try:
        print(f"[{slug}] submitting...", flush=True)
        q = submit(slug, size, prompt)
        print(f"[{slug}] queued: {q.get('request_id', '?')}", flush=True)
        result = wait(q, slug)
        images = result.get("images") or []
        if not images:
            print(f"[{slug}] no images in result: {json.dumps(result)[:400]}", flush=True)
            return
        url = images[0].get("url")
        png_path = GEN / f"{slug}.png"
        size_b = download(url, png_path)
        print(f"[{slug}] saved {png_path.name} ({size_b//1024} KB)", flush=True)
    except Exception as e:
        traceback.print_exc()
        print(f"[{slug}] FAILED: {e}", flush=True)


def main():
    threads = []
    for slug, size, prompt in RENDERS:
        t = threading.Thread(target=run_one, args=(slug, size, prompt), daemon=False)
        t.start()
        threads.append(t)
        time.sleep(0.5)  # stagger so we don't burst-rate-limit
    for t in threads:
        t.join()
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
