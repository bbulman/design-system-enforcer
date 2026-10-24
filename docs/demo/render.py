"""Render the captured `ds-enforcer init` + `check` session on shadcn/taxonomy as a GIF.
The output text is the real captured output; only the absolute project path is shortened."""
import re, sys
from PIL import Image, ImageDraw, ImageFont

INIT, CHECK, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'
BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf'
SIZE, LH, COLS, ROWS, PAD, BAR = 15, 21, 130, 30, 22, 34
f = ImageFont.truetype(FONT, SIZE); fb = ImageFont.truetype(BOLD, SIZE)
CW = f.getlength('M')
W, H = int(PAD * 2 + CW * COLS), PAD * 2 + BAR + LH * ROWS
BG, WIN, FG, DIM = '#0E1116', '#161B22', '#E6EDF3', '#7D8590'
GREEN, RED, AMBER, CYAN, BLUE = '#3FB950', '#F85149', '#D29922', '#56D4DD', '#79C0FF'
HOME = '~/code/taxonomy'
PROMPT = [(HOME, CYAN, True), (' $ ', DIM, False)]

def segs(line, kind):
    """Colour one line of output: [(text, colour, bold)]."""
    if kind == 'cmd':
        return PROMPT + [(line, FG, True)]
    if not line.strip():
        return [(line, FG, False)]
    if line.startswith('Design System Enforcer'):
        return [(line, FG, True)]
    if line.startswith(('Tokens:', 'Components:', 'About to connect', 'Next:')):
        return [(line, FG, True)]
    if line.startswith('Connected'):
        return [(line, GREEN, True)]
    m = re.match(r'^(  )(✓| )( \[\d+\] )(\S+)(.*)$', line)
    if m:
        return [(m[1], FG, False), (m[2], GREEN, True), (m[3], DIM, False), (m[4], FG, True), (m[5], DIM, False)]
    m = re.match(r'^(\s+\d+  )(high|medium|low)(\s+)(.*)$', line)
    if m:
        col = {'high': RED, 'medium': AMBER, 'low': DIM}[m[2]]
        return [(m[1], DIM, False), (m[2], col, True), (m[3], FG, False), (m[4], FG, False)]
    if line.lstrip().startswith('→'):
        return [(line, DIM, False)]
    if line.startswith('✖'):
        return [('✖', RED, True), (line[1:], FG, True)]
    if line.startswith('✔'):
        return [('✔', GREEN, True), (line[1:], FG, True)]
    if kind == 'check' and not line.startswith(' '):
        return [(line, BLUE, True)]
    if line.startswith(('Project:', 'Scanning')) or line.startswith('  Tailwind'):
        return [(line, DIM, False)]
    return [(line, FG, False)]

frames, durations = [], []
screen = []          # list of segment lists
cursor = True

def draw(hold, show_cursor=True):
    img = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([6, 6, W - 7, H - 7], radius=12, fill=WIN, outline='#30363D')
    for i, c in enumerate(['#FF5F57', '#FEBC2E', '#28C840']):
        d.ellipse([22 + i * 20, 18, 34 + i * 20, 30], fill=c)
    title = 'ds-enforcer · shadcn/taxonomy'
    d.text(((W - f.getlength(title)) / 2, 15), title, font=f, fill=DIM)
    visible = screen[-ROWS:]
    for r, line in enumerate(visible):
        x, y = PAD, PAD + BAR + r * LH
        for text, col, bold in line:
            font = fb if bold else f
            d.text((x, y), text, font=font, fill=col)
            x += CW * len(text)
        if show_cursor and r == len(visible) - 1:
            last_x = x
    if show_cursor and visible:
        y = PAD + BAR + (len(visible) - 1) * LH
        d.rectangle([last_x + 1, y + 3, last_x + CW - 1, y + LH - 3], fill='#C9D1D9')
    frames.append(img)
    durations.append(int(hold))

def newline(seglist=None):
    screen.append(seglist or [('', FG, False)])

def type_into_last(text, colour=FG, bold=True, per=2, ms=45):
    for i in range(0, len(text), per):
        chunk = text[i:i + per]
        screen[-1] = screen[-1] + [(chunk, colour, bold)]
        draw(ms)

def run(cmd):
    newline(list(PROMPT))
    draw(500)
    type_into_last(cmd)
    draw(350)

PROMPTS = re.compile(r'^(.*(?:ones|go on|\(Enter for 16\)|\(y/N\)|\(Y/n\)):) ?(.*)$')

def play(path, kind, stop_at=None):
    lines = open(path, encoding='utf8').read().split('\n')
    for line in lines:
        if stop_at and line.startswith(stop_at):
            break
        line = re.sub(r'/sessions/[^ ]*/demo/taxonomy', HOME, line)
        m = PROMPTS.match(line)
        if kind == 'init' and m:
            newline([(m[1] + ' ', FG, True)])
            draw(700)
            answer = m[2] or '↵'
            type_into_last(answer, CYAN if m[2] else DIM, True, per=1, ms=120)
            draw(250)
            continue
        newline(segs(line, kind))
        draw(28 if kind == 'init' else 70, show_cursor=False)

newline([])
run('ds-enforcer init')
play(INIT, 'init', stop_at='Next:')
draw(1600)
run('ds-enforcer check app')
play(CHECK, 'check')
newline(list(PROMPT))
draw(4500)

# One palette for every frame, built from the busiest frame, so colours stay true and steady.
pal = frames[-1].quantize(colors=128, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
gif = [fr.quantize(palette=pal, dither=Image.Dither.NONE) for fr in frames]
gif[0].save(OUT, save_all=True, append_images=gif[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(len(frames), 'frames', W, 'x', H)
