# Headless-Prüfung Iteration 3: Konsole + Screenshots. Aufruf: python3 tools/check_v3.py [quick]
import asyncio, sys, json
from playwright.async_api import async_playwright
D = '/workspace/riedberg3d/'
async def main():
    quick = 'quick' in sys.argv
    q = next((a.split('=')[1] for a in sys.argv if a.startswith('q=')), 'standard')
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True,
            args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'])
        pg = await b.new_page(viewport={'width': 1600, 'height': 950})
        errs = []
        pg.on('console', lambda m: errs.append(f'console.{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))
        pg.on('requestfailed', lambda r: errs.append(f'requestfailed: {r.url[:120]} {r.failure}'))
        await pg.goto(f'http://localhost:8080/index.html?q={q}')
        try:
            await pg.wait_for_function('window.__ready === true', timeout=300000)
            await pg.wait_for_function('window.__transitReady === true', timeout=120000)
        except Exception as e: errs.append('timeout ' + str(e)[:200])
        await pg.wait_for_timeout(5000)
        async def slider(minutes, wait=3000):
            await pg.eval_on_selector('#time-slider', f'(e) => {{ e.value = {minutes}; e.dispatchEvent(new Event("input")); }}')
            await pg.wait_for_timeout(wait)
        async def view(name, wait=4000):
            await pg.click(f'[data-view={name}]'); await pg.wait_for_timeout(wait)
        async def cam(pos, tgt, wait=3000):
            await pg.evaluate(f'window.__cam && window.__cam({json.dumps(pos)}, {json.dumps(tgt)})'); await pg.wait_for_timeout(wait)
        await slider(780)
        await view('overview'); await pg.screenshot(path=D + 'screenshot_v3_uebersicht_tag.png')
        if not quick:
            for i in ('l-lines', 'l-stops'): await pg.uncheck('#' + i)
            await cam(*STREET); await pg.screenshot(path=D + 'screenshot_v3_strasse_tag.png')
            await slider(1310, 4000); await cam(*NIGHT); await pg.screenshot(path=D + 'screenshot_v3_nacht_laternen.png')
            for i in ('l-lines', 'l-stops'): await pg.check('#' + i)
            await pg.click('#btn-now'); await pg.wait_for_timeout(1500)
            r = await pg.evaluate('''() => { const d = window.__dbg(); const i = d.veh.findIndex(v => v[4] === 'gtfs.de' && v[5] > 60);
              const j = i >= 0 ? i : d.veh.findIndex(v => v[4] === 'gtfs.de'); return window.__follow(j >= 0 ? j : 0, 70); }''')
            print('FOLLOW:', r); await pg.wait_for_timeout(4000)
            await pg.screenshot(path=D + 'screenshot_v3_folgen_verspaetung.png')
            print('INFO:', (await pg.inner_text('#info')).replace('\n', ' | '))
            await pg.keyboard.press('Escape'); await pg.wait_for_timeout(500)
            print('AFTER ESC:', (await pg.inner_text('#info .hint')))
        for qq in ('hoch', 'mobil', 'niedrig', q):  # Live-Umschalten der Qualitätsstufen
            await pg.select_option('#quality', qq); await pg.wait_for_timeout(1500)
        print('QUALITY:', await pg.evaluate("localStorage.getItem('riedberg3d.quality')"))
        print('FPS:', await pg.inner_text('#fps'))
        print('STATUS:', (await pg.inner_text('#rt-status')).replace('\n', ' | '))
        print('LOAD:', await pg.inner_text('#load-status'))
        print('DEP:', (await pg.inner_text('#departures'))[:700].replace('\n', ' | '))
        print('DBG:', json.dumps(await pg.evaluate('window.__dbg && window.__dbg()'))[:1500])
        print('ERRORS:', *errs, sep='\n')
        await b.close()
STREET = ([8.6323, 50.1781, 8], [8.6310, 50.1774, 0]); NIGHT = ([8.6343, 50.1788, 22], [8.6362, 50.1800, 0])
if __name__ == '__main__': asyncio.run(main())
