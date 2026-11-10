-- Body of the "VDD Download Video/Image" Quick Actions (Safari keyboard shortcuts).
-- install-safari-shortcuts.sh fills in __KIND__ (video | image).
on run {input, parameters}
	set base to "http://127.0.0.1:17723"
	try
		set js to do shell script "curl -s -m 3 " & quoted form of (base & "/safari.js?kind=__KIND__")
	on error
		set js to ""
	end try
	if js is "" then
		display notification "VDD helper is not running. Double-click Start VDD.command." with title "VDD"
		return input
	end if
	tell application "Safari"
		if (count of windows) is 0 then return input
		set t to current tab of front window
		try
			do JavaScript js in t
		on error
			display notification "In Safari: Develop → Allow JavaScript from Apple Events, then try again." with title "VDD"
			return input
		end try
		set r to ""
		repeat 60 times
			delay 0.25
			set r to do JavaScript "window.__vddResult || ''" in t
			if r is not missing value and r is not "" then exit repeat
		end repeat
	end tell
	if r is missing value or r is "" then
		display notification "Timed out looking for a video or photo on this page." with title "VDD"
		return input
	end if
	do shell script "curl -s -m 5 -X POST -H 'Content-Type: application/json' --data-binary " & quoted form of r & " " & quoted form of (base & "/download")
	return input
end run
