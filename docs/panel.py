from PIL import Image, ImageDraw, ImageFont

# TRMNL OG is 800x480, 1-bit. Draw at 3x and downsample: PIL's own
# hinting at 96px is coarse, and the supersample gives the smooth edges
# the real panel's renderer produces.
S = 3
W, H = 800 * S, 480 * S
F = "/usr/share/fonts/truetype/dejavu/DejaVuSans%s.ttf"
def font(px, bold=False): return ImageFont.truetype(F % ("-Bold" if bold else ""), px * S)

img = Image.new("L", (W, H), 255)
d = ImageDraw.Draw(img)
BLACK, GRAY = 0, 115

M = 26 * S                       # page margin
GUT = 22 * S                     # gutter between the two columns
BAR = 46 * S                     # title bar height
inner = W - 2 * M
col5 = int(inner * 5 / 12) - GUT // 2   # col--span-5
x2 = M + col5 + GUT                     # right column origin

def text(x, y, s, f, fill=BLACK):
    d.text((x, y), s, font=f, fill=fill)
    return y + (f.getbbox(s)[3] - f.getbbox(s)[1])

def rule(x, y, w, weight=2):
    d.rectangle([x, y, x + w, y + weight * S - 1], fill=BLACK)

# ---- left column: the one number worth the whole screen -------------------
y = M
f_lab = font(13, True)
d.text((M, y), "RESETS AT", font=f_lab, fill=BLACK)
y += 19 * S
rule(M, y, col5)
y += 14 * S

# value--xxlarge. Genuinely this big on the panel: it is the one number the
# screen exists to show, readable from across a room.
f_big = font(90, True)
d.text((M - 4 * S, y - 12 * S), "01:00", font=f_big, fill=BLACK)
y += 104 * S

y = text(M, y, "about 2h 30m left", font(24)) + 14 * S
# One line, exactly as full.liquid renders it.
text(M, y, "54.1M this block · 366k/min", font(17), GRAY)

# ---- right column: the day, split by model -------------------------------
y = M
d.text((x2, y), "TODAY — 236.6M", font=f_lab, fill=BLACK)
y += 19 * S
rule(x2, y, W - M - x2)
y += 16 * S

# title--base + description--small per model. No bars: the template does not
# draw any, and this image has to show what the plugin actually renders.
f_model, f_sub = font(25, True), font(16)
for name, tot, pct in [("Opus 5", "138.4M", 58), ("Sonnet 5", "81.6M", 34), ("Opus 4", "16.6M", 7)]:
    d.text((x2, y), name, font=f_model, fill=BLACK)
    y += 31 * S
    d.text((x2, y), f"{tot} · {pct}% of today", font=f_sub, fill=GRAY)
    y += 36 * S

d.text((x2, y + 4 * S), "Currently mostly Opus 5", font=font(16), fill=GRAY)

# ---- title bar -----------------------------------------------------------
by = H - BAR
rule(0, by, W, 2)
f_t, f_i = font(17, True), font(15)
d.text((M, by + 14 * S), "Claude usage", font=f_t, fill=BLACK)
s = "as of 22:28"
d.text((W - M - d.textlength(s, font=f_i), by + 15 * S), s, font=f_i, fill=GRAY)

out = img.resize((800, 480), Image.LANCZOS)
import os
out.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), "panel.png"), optimize=True)
print("wrote docs/panel.png", out.size)
