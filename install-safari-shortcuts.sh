#!/bin/bash
# Adds two Safari keyboard shortcuts (macOS Quick Actions):
#   ⌥⇧D  VDD Download Video         ⌥⇧I  VDD Download Image (photo or video cover)
# Also listed in Safari → Services. Undo with: ./install-safari-shortcuts.sh --remove
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICES="$HOME/Library/Services"
if [ "$1" = "--remove" ]; then
  rm -rf "$SERVICES/VDD Download Video.workflow" "$SERVICES/VDD Download Image.workflow"
  /System/Library/CoreServices/pbs -update 2>/dev/null || true
  echo "Safari shortcuts removed."; exit 0
fi
mkdir -p "$SERVICES"
/usr/bin/python3 - "$DIR/safari/quick_action.applescript" "$SERVICES" <<'PY'
import plistlib, subprocess, sys, uuid
from pathlib import Path

template, services = Path(sys.argv[1]).read_text(), Path(sys.argv[2])
SAFARI = "/Applications/Safari.app"
for kind, title, key in (("video", "VDD Download Video", "~$d"), ("image", "VDD Download Image", "~$i")):
    script = template.replace("__KIND__", kind)
    contents = services / f"{title}.workflow" / "Contents"
    contents.mkdir(parents=True, exist_ok=True)
    plistlib.dump({
        "CFBundleName": title,
        "NSServices": [{
            "NSMenuItem": {"default": title},
            "NSMessage": "runWorkflowAsService",
            "NSRequiredContext": {"NSApplicationIdentifier": "com.apple.Safari"},
        }],
    }, open(contents / "Info.plist", "wb"))
    action = {
        "AMAccepts": {"Container": "List", "Optional": True, "Types": ["com.apple.applescript.object"]},
        "AMActionVersion": "1.0.2",
        "AMApplication": ["Automator"],
        "AMParameterProperties": {"source": {}},
        "AMProvides": {"Container": "List", "Types": ["com.apple.applescript.object"]},
        "ActionBundlePath": "/System/Library/Automator/Run AppleScript.action",
        "ActionName": "Run AppleScript",
        "ActionParameters": {"source": script},
        "BundleIdentifier": "com.apple.Automator.RunScript",
        "CFBundleVersion": "1.0.2",
        "CanShowSelectedItemsWhenRun": False,
        "CanShowWhenRun": True,
        "Category": ["AMCategoryUtilities"],
        "Class Name": "RunScriptAction",
        "InputUUID": str(uuid.uuid4()).upper(),
        "Keywords": ["Run"],
        "OutputUUID": str(uuid.uuid4()).upper(),
        "UUID": str(uuid.uuid4()).upper(),
        "UnlocalizedApplications": ["Automator"],
        "arguments": {"0": {"default value": script, "name": "source", "required": "0", "type": "0", "uuid": "0"}},
        "isViewVisible": True,
        "location": "449.5:253",
    }
    plistlib.dump({
        "AMApplicationBuild": "523",
        "AMApplicationVersion": "2.10",
        "AMDocumentVersion": "2",
        "actions": [{"action": action, "isViewVisible": True}],
        "connectors": {},
        "workflowMetaData": {
            "applicationBundleID": "com.apple.Safari",
            "applicationBundleIDsByPath": {SAFARI: "com.apple.Safari"},
            "applicationPath": SAFARI,
            "applicationPaths": [SAFARI],
            "inputTypeIdentifier": "com.apple.Automator.nothing",
            "outputTypeIdentifier": "com.apple.Automator.nothing",
            "presentationMode": 11,
            "processesInput": False,
            "serviceApplicationBundleID": "com.apple.Safari",
            "serviceApplicationPath": SAFARI,
            "serviceInputTypeIdentifier": "com.apple.Automator.nothing",
            "serviceOutputTypeIdentifier": "com.apple.Automator.nothing",
            "serviceProcessesInput": False,
            "systemImageName": "NSActionTemplate",
            "useAutomaticInputType": False,
            "workflowTypeIdentifier": "com.apple.Automator.servicesMenu",
        },
    }, open(contents / "document.wflow", "wb"))
    # Keyboard shortcut (same as System Settings → Keyboard → Keyboard Shortcuts → Services).
    subprocess.run(["defaults", "write", "pbs", "NSServicesStatus", "-dict-add",
                    f'"(null) - {title} - runWorkflowAsService"',
                    '{ "key_equivalent" = "%s"; "enabled_context_menu" = 1; "enabled_services_menu" = 1; '
                    '"presentation_modes" = { ContextMenu = 1; ServicesMenu = 1; }; }' % key], check=True)
    print("installed:", title)
PY
/System/Library/CoreServices/pbs -flush 2>/dev/null || true
/System/Library/CoreServices/pbs -update 2>/dev/null || true
cat <<MSG

Done. One-time setup in Safari:
  1. Safari → Settings → Advanced → "Show features for web developers"
  2. Develop menu → "Allow JavaScript from Apple Events" (Safari asks you to confirm)
Then on an Instagram / Threads page press:
  ⌥⇧D  download the video on screen
  ⌥⇧I  download the photo on screen (or the cover of the video)
The first time, macOS asks whether to allow controlling Safari: click OK.
MSG
