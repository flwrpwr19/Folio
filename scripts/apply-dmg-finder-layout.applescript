-- Apply DMG window layout via Finder (required on macOS 26+ for background images).
-- Args: mount path, volume name, app display name (e.g. Folio).
on run argv
	set mountPath to item 1 of argv
	set volName to item 2 of argv
	set appName to item 3 of argv
	set bgPath to mountPath & "/.background/background.png"

	tell application "Finder"
		activate
		tell disk volName
			open
			delay 2
			set w to container window
			set current view of w to icon view
			set toolbar visible of w to false
			set statusbar visible of w to false
			set bounds of w to {200, 120, 840, 520}
			set vo to icon view options of w
			set arrangement of vo to not arranged
			set icon size of vo to 96
			set background picture of vo to (POSIX file bgPath as alias)
			set position of item (appName & ".app") of w to {150, 185}
			set position of item "Applications" of w to {450, 185}
			close
			open
			update without registering applications
			delay 2
			close
		end tell
	end tell
end run
