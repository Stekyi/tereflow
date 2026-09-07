"""
Rendering a page in a real browser, for the sources that build their tables in
JavaScript after the HTML arrives.

Some of the most valuable sources in the registry hand back an almost empty
shell and then draw the actual dataset with a client-side framework. The
Harvard Growth Lab download page is one: fetched with httpx it has zero data
links, because the links do not exist until React has run. A static parser is
right to find nothing there, and equally right that the data is real and
reachable. The gap between those two facts is exactly what this module closes,
by driving a headless Chromium that runs the page's JavaScript the way a
visitor's browser would, then handing back the HTML that resulted.

Playwright is heavy and is not installed in this environment on purpose. That
is treated as a normal state, not a failure. `rendering_available` reports it
plainly and says how to fix it, and `render` refuses to run rather than
pretending. The one thing it must never do is return an empty page that a
caller would read as "this URL has no tables", because that would turn a
missing dependency into a silent wrong answer about the data. So an
unavailable renderer returns None and a reason, and None is unmistakably not a
page.

The code is written to work the moment `pip install playwright && playwright
install chromium` has been run. Nothing here is a placeholder.
"""

from __future__ import annotations

# A desktop Chrome identity. Several government portals answer a default
# automation user agent with 403 (comexstat.mdic.gov.br is one), so presenting
# as an ordinary browser is not cosmetic, it is what makes the fetch succeed.
_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

_INSTALL_HINT = "pip install playwright && playwright install chromium"


def rendering_available() -> tuple[bool, str]:
    """
    Report whether a browser can be driven, and if not, how to enable it.

    The import is attempted rather than assumed, because "installed" and
    "importable" are the honest test. The reason string names the install
    command so the caller, or a human reading a log, can act on it without
    guessing.
    """
    try:
        import playwright  # noqa: F401
        from playwright.sync_api import sync_playwright  # noqa: F401
    except ImportError as exc:
        return False, (
            f"Playwright is not installed ({exc}). "
            f"Dynamic rendering is disabled. To enable it run: {_INSTALL_HINT}"
        )
    return True, "Playwright is available."


def render(
    url: str, *, wait_ms: int = 3000, timeout_ms: int = 30000
) -> tuple[bytes | None, str]:
    """
    Load a URL in headless Chromium and return the rendered HTML as bytes.

    Returns (html_bytes, note) on success and (None, reason) on every failure,
    including the renderer being unavailable. None is the deliberate signal for
    "no page was produced"; empty bytes are never returned in its place, so a
    caller can trust that bytes means a page actually rendered.

    `wait_ms` is an extra pause after the network goes idle, for charts and
    tables that a framework draws a beat later. `timeout_ms` bounds navigation.
    """
    available, reason = rendering_available()
    if not available:
        return None, reason

    from playwright.sync_api import sync_playwright
    from playwright.sync_api import Error as PlaywrightError
    from playwright.sync_api import TimeoutError as PlaywrightTimeout

    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                context = browser.new_context(
                    user_agent=_USER_AGENT,
                    viewport={"width": 1366, "height": 900},
                    locale="en-US",
                )
                page = context.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)

                # Network idle is the signal that the page's own fetches have
                # settled. It can legitimately never fire on pages that poll, so
                # a timeout here is caught and treated as "settled enough"
                # rather than allowed to fail the whole render.
                try:
                    page.wait_for_load_state("networkidle", timeout=timeout_ms)
                except PlaywrightTimeout:
                    pass

                # The extra wait is for late client-side rendering that happens
                # after the network is quiet, which is the whole reason this
                # module exists.
                page.wait_for_timeout(max(0, wait_ms))

                content = page.content()
                if not content:
                    # A browser that returned nothing is a failure, not an
                    # empty page. Say so rather than hand back bytes that read
                    # as a tableless document.
                    return None, f"Rendered an empty document from {url}."
                return content.encode("utf-8"), f"Rendered {url} with headless Chromium."
            finally:
                browser.close()
    except PlaywrightTimeout as exc:
        return None, f"Timed out rendering {url} after {timeout_ms} ms: {exc}"
    except PlaywrightError as exc:
        return None, f"Browser error rendering {url}: {exc}"
    except Exception as exc:
        return None, f"Unexpected error rendering {url}: {exc}"
