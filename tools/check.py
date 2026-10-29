import asyncio, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True,
            args=['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'])
        pg = await b.new_page(viewport={'width': 1600, 'height': 950})
        errs = []
        pg.on('console', lambda m: errs.append(f'console.{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        pg.on('pageerror', lambda e: errs.append(f'pageerror: {e}'))
        pg.on('requestfailed', lambda r: errs.append(f'requestfailed: {r.url[:120]} {r.failure}'))
        await pg.goto('http://localhost:8080/index.html')
        await pg.wait_for_function('window.__ready === true', timeout=180000)
        try: await pg.wait_for_function('window.__transitReady === true', timeout=60000)
        except Exception as e: errs.append('transit timeout ' + str(e)[:100])
        await pg.wait_for_timeout(8000)
        D = '/workspace/riedberg3d/'
        async def slider(minutes):  # Uhrzeit über den Regler setzen (wie ein Nutzer)
            await pg.eval_on_selector('#time-slider', f'(e) => {{ e.value = {minutes}; e.dispatchEvent(new Event("input")); }}')
            await pg.wait_for_timeout(2500)
        await slider(780); await pg.screenshot(path=D + 'screenshot_tag.png')
        await slider(1320); await pg.screenshot(path=D + 'screenshot_nacht.png')
        await slider(900); await pg.screenshot(path=D + 'screenshot_wetter.png')
        await pg.select_option('#wx-preview', 'regen'); await pg.wait_for_timeout(2500); await pg.screenshot(path=D + 'screenshot_regen.png')
        await pg.select_option('#wx-preview', ''); await pg.click('#btn-now'); await pg.wait_for_timeout(1500)
        await pg.screenshot(path=D + 'screenshot.png')
        print('CLOCK:', await pg.inner_text('#clock'), '|', await pg.inner_text('#timemode'))
        print('WEATHER:', (await pg.inner_text('#weather')).replace('\n', ' | '))
        await slider(780); await pg.click('[data-view=overview]'); await pg.wait_for_timeout(4000); await pg.screenshot(path=D + 'screenshot_uebersicht.png')
        print('STATUS:', await pg.inner_text('#rt-status'))
        print('LOAD:', await pg.inner_text('#load-status'))
        print('DEP:', (await pg.inner_text('#departures'))[:900])
        print('DBG:', await pg.evaluate('window.__dbg && window.__dbg()'))
        print('ERRORS:', *errs, sep='\n')
        await b.close()
asyncio.run(main())
