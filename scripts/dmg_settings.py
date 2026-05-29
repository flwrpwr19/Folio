# dmgbuild settings for Folio macOS installer (see scripts/create-release-dmg.sh).
# Defines are passed on the command line: application, background, app_name.

application = defines["application"]
app_name = defines.get("app_name", "Folio")
background = defines["background"]

format = "UDZO"
filesystem = "HFS+"
size = "220M"

files = [application]
symlinks = {"Applications": "/Applications"}

icon_locations = {
    f"{app_name}.app": (150, 185),
    "Applications": (450, 185),
}

window_rect = ((200, 120), (640, 400))
default_view = "icon-view"
show_status_bar = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
icon_size = 96
text_size = 12

hide = [".background.png"]
