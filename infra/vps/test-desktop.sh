#!/bin/bash
# Verifies the bot desktop in a container run the way the supervisor runs bot computers.
set -u
IMAGE=${1:-rakazo-custom/computer:xfce-test}
C=rk-dt
VOL=rk-dt-home
OUT=/root/dt-shots; rm -rf $OUT; mkdir -p $OUT
pass=0; fail=0
ok(){ echo "PASS  $*"; pass=$((pass+1)); }
bad(){ echo "FAIL  $*"; fail=$((fail+1)); }
x(){ docker exec $C bash -lc "$1" 2>/dev/null; }
run(){ docker run -d --name $C --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true \
  --shm-size 256m --pids-limit 2048 -m 2g --network none -v $VOL:/home/rakazo "$IMAGE" >/dev/null; }
count(){ x "pgrep -c -f \"$1\"" || echo 0; }
on_display(){ # processes named $1 whose env has DISPLAY=$2
  x "for p in \$(pgrep -x $1); do tr '\\0' '\\n' </proc/\$p/environ | grep -qx 'RAKAZO_DESKTOP_DISPLAY=$2' && echo \$p; done | wc -l"; }
shot(){ x "DISPLAY=$1 import -window root /tmp/s.png" && docker cp $C:/tmp/s.png $OUT/$2.png >/dev/null; }
wait_panel(){ for i in $(seq 1 40); do [ "$(on_display xfce4-panel $1)" = 1 ] && [ "$(on_display xfwm4 $1)" = 1 ] && return 0; sleep 0.5; done; return 1; }

docker rm -f $C >/dev/null 2>&1; docker volume rm $VOL >/dev/null 2>&1
docker volume create $VOL >/dev/null
docker run --rm -v $VOL:/h busybox chown 1000:1000 /h

echo "== fresh computer, first display"
run; sleep 3
wait_panel :1 && ok "display :1 has one window manager and one panel" || bad "display :1 desktop missing"
[ "$(x 'pgrep -c -x Xvfb')" = 1 ] && ok "one bot, one display: the desktop added no display" || bad "Xvfb count $(x 'pgrep -c -x Xvfb') for one bot"
[ "$(x 'id -u')" = 1000 ] && ok "runs as uid 1000, no root" || bad "not uid 1000"
x "grep -q 'xfwm4' /proc/\$(pgrep -x xfwm4 | head -1)/cmdline" && ok "xfwm4 is the window manager" || bad "no xfwm4"
x "test -f ~/.config/rakazo-desktop/primary/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml" && ok "panel config initialised for primary display" || bad "no panel config"
x "ls ~/.config/rakazo-desktop/primary/xfce4/panel" | tr '\n' ' '; echo
sleep 2; shot :1 d1-fresh

echo "== second bot display, started the way the runtime does"
x 'Xvfb :2 -screen 0 1280x800x24 -ac +extension RANDR +render -noreset -nolisten tcp >/tmp/rakazo/screen-2-xvfb.log 2>&1 & for i in $(seq 1 100); do xdpyinfo -display :2 >/dev/null 2>&1 && break; sleep 0.1; done; mkdir -p /tmp/fluxbox-home-2/.fluxbox; HOME=/home/rakazo CHROME_USER_DATA_DIR=/home/rakazo/.browser-profiles/chromium-bot-0123456789abcdef0123456789abcdef BROWSER=/usr/local/bin/rakazo-browser DISPLAY=:2 nohup fluxbox -rc /tmp/fluxbox-home-2/.fluxbox/init </dev/null >/tmp/rakazo/screen-2-fluxbox.log 2>&1 &'
wait_panel :2 && ok "display :2 has its own window manager and panel" || bad "display :2 desktop missing"
[ "$(x 'pgrep -c -x Xvfb')" = 2 ] && ok "two bots, two displays: none added for the desktop" || bad "Xvfb count $(x 'pgrep -c -x Xvfb') for two bots"
x "test -d ~/.config/rakazo-desktop/chromium-bot-0123456789abcdef0123456789abcdef/xfce4/panel/launcher-2" && ok "display :2 settings kept per bot" || bad "no per-bot settings"
b1=$(x "tr '\\0' '\\n' </proc/\$(pgrep -x xfce4-panel | head -1)/environ | grep DBUS_SESSION_BUS_ADDRESS")
b2=$(x "tr '\\0' '\\n' </proc/\$(pgrep -x xfce4-panel | tail -1)/environ | grep DBUS_SESSION_BUS_ADDRESS")
[ -n "$b1" ] && [ "$b1" != "$b2" ] && ok "each display has its own D-Bus session" || bad "displays share a D-Bus session"
sleep 2; shot :2 d2-fresh

echo "== starting display :2 again does not duplicate"
x 'HOME=/home/rakazo CHROME_USER_DATA_DIR=/home/rakazo/.browser-profiles/chromium-bot-0123456789abcdef0123456789abcdef BROWSER=/usr/local/bin/rakazo-browser DISPLAY=:2 nohup fluxbox -rc /tmp/fluxbox-home-2/.fluxbox/init </dev/null >>/tmp/rakazo/screen-2-fluxbox.log 2>&1 &'
sleep 4; wait_panel :2
[ "$(on_display xfce4-panel :2)" = 1 ] && [ "$(on_display xfwm4 :2)" = 1 ] && ok "still one panel and one window manager on :2" || bad "duplicates on :2: panels=$(on_display xfce4-panel :2) wms=$(on_display xfwm4 :2)"
[ "$(on_display xfce4-panel :1)" = 1 ] && ok ":1 untouched by :2 restart" || bad ":1 disturbed"
[ "$(x 'pgrep -c -x xfce4-panel')" = 2 ] && ok "exactly two panels in the container" || bad "panel count $(x 'pgrep -c -x xfce4-panel')"

echo "== launchers on :2 (clicked through the panel)"
echo "$(x 'DISPLAY=:2 xdotool getdisplaygeometry')"
win(){ x "DISPLAY=$1 wmctrl -lx" ; }
click(){ x "DISPLAY=$1 xdotool mousemove $2 $3 click 1"; }
x 'echo /home/rakazo/.browser-profiles/chromium-bot-0123456789abcdef0123456789abcdef > /tmp/rakazo/browser-profile-2; mkdir -p /home/rakazo/.browser-profiles/chromium-bot-0123456789abcdef0123456789abcdef'
click :2 210 780; sleep 4
win :2 | grep -qi "xfce4-terminal" && ok "Terminal launcher opens xfce4-terminal on :2" || bad "no terminal on :2"
win :1 | grep -qi "xfce4-terminal" && bad "terminal leaked onto :1" || ok "terminal stayed on its own display"
x 'DISPLAY=:2 xdotool type --delay 30 "echo typed-on-2 > /tmp/typed-2"; DISPLAY=:2 xdotool key Return'; sleep 1
[ "$(x 'cat /tmp/typed-2')" = typed-on-2 ] && ok "keyboard input reaches the terminal" || bad "typing failed"
click :2 170 780; sleep 4
win :2 | grep -qi "thunar" && ok "File Manager launcher opens Thunar on :2" || bad "no Thunar on :2"
click :2 130 780; sleep 8
win :2 | grep -qi "google-chrome" && ok "Browser launcher opens Chrome on :2" || bad "no Chrome on :2"
x "pgrep -af 'chrome.*--user-data-dir=/home/rakazo/.browser-profiles/chromium-bot-0123456789abcdef0123456789abcdef' | grep -v -- --type= | head -1" | grep -q remote-debugging-port && ok "browser uses the bot's own profile and debugging port" || bad "browser profile not the bot's"
shot :2 d2-apps
for id in $(win :2 | awk '{print $1}'); do x "DISPLAY=:2 wmctrl -ic $id"; done; sleep 3
[ -z "$(win :2 | grep -iE 'terminal|thunar')" ] && ok "windows closed" || bad "windows still open"
x "ls ~/.config/rakazo-desktop/chromium-bot-0123456789abcdef0123456789abcdef/xfce4/panel/launcher-*/*.desktop | wc -l" | grep -qx 3 && ok "three launchers still configured after closing apps" || bad "launchers missing"
[ "$(on_display xfce4-panel :2)" = 1 ] && ok "panel still running after closing apps" || bad "panel gone"
shot :2 d2-closed

echo "== five bots at once"
for n in 3 4 5 6; do
  x "Xvfb :$n -screen 0 1280x800x24 -ac +extension RANDR +render -noreset -nolisten tcp >/tmp/rakazo/screen-$n-xvfb.log 2>&1 & for i in \$(seq 1 100); do xdpyinfo -display :$n >/dev/null 2>&1 && break; sleep 0.1; done; mkdir -p /tmp/fluxbox-home-$n/.fluxbox /home/rakazo/.browser-profiles/chromium-bot-$n$n$n; echo /home/rakazo/.browser-profiles/chromium-bot-$n$n$n > /tmp/rakazo/browser-profile-$n; HOME=/home/rakazo CHROME_USER_DATA_DIR=/home/rakazo/.browser-profiles/chromium-bot-$n$n$n BROWSER=/usr/local/bin/rakazo-browser DISPLAY=:$n nohup fluxbox -rc /tmp/fluxbox-home-$n/.fluxbox/init </dev/null >/tmp/rakazo/screen-$n-fluxbox.log 2>&1 &"
done
for n in 3 4 5 6; do wait_panel :$n || bad "display :$n desktop missing"; done
sleep 3  # let the newest panels finish drawing their launchers before clicking
for n in 2 3 4 5 6; do click :$n 130 780; done; sleep 12
ok_all=1; for n in 2 3 4 5 6; do win :$n | grep -qi google-chrome || ok_all=0; done
[ $ok_all = 1 ] && ok "five bots each have their own browser window on their own display" || bad "a bot is missing its browser: $(for n in 2 3 4 5 6; do echo -n ":$n=$(win :$n | grep -ci chrome) "; done)"
profiles=$(x "pgrep -af 'chrome ' | grep -v -- --type= | grep -o 'user-data-dir=[^ ]*' | sort -u | wc -l")
echo "      distinct browser profiles running: $profiles"
[ "$(x 'pgrep -c -x xfce4-panel')" = 6 ] && ok "six displays, six panels, no duplicates" || bad "panel count $(x 'pgrep -c -x xfce4-panel')"
echo "      memory in use by the computer: $(docker stats --no-stream --format '{{.MemUsage}}' $C)"
shot :5 d5-browser

echo "== a bot's display stops (runtime stop commands)"
x 'pkill -f "[X]vfb :4 -screen"; pkill -f "[f]luxbox -rc /tmp/fluxbox-home-4/.fluxbox/init"'; sleep 4
left=$(x "for p in /proc/[0-9]*; do tr '\\0' '\\n' <\$p/environ 2>/dev/null | grep -qx 'RAKAZO_DESKTOP_DISPLAY=:4' && echo \${p#/proc/}; done | wc -l")
[ "$left" = 0 ] && ok "display :4 left no desktop processes" || bad "$left desktop processes left on :4"
[ "$(on_display xfce4-panel :5)" = 1 ] && [ "$(on_display xfce4-panel :1)" = 1 ] && ok "other bots' desktops kept running" || bad "stopping :4 disturbed others"
x "test -d /home/rakazo/.browser-profiles/chromium-bot-444" && ok "stopped bot's browser profile kept" || bad "profile removed"

echo "== a customization survives restart"
x 'DISPLAY=:1 DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/rakazo/desktop-1/bus xfconf-query -c xfce4-panel -p /plugins/plugin-7/digital-layout -n -t uint -s 3' 
sleep 1
docker restart $C >/dev/null; sleep 3
wait_panel :1 && ok "after container restart :1 desktop is back" || bad "no desktop after restart"
[ "$(x 'pgrep -c -x xfce4-panel')" = 1 ] && ok "one panel after restart" || bad "panels after restart: $(x 'pgrep -c -x xfce4-panel')"
x "grep -q 'digital-layout' ~/.config/rakazo-desktop/primary/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml" && ok "panel customization kept across restart" || bad "customization lost"

echo "== recreated container on the same home"
docker rm -f $C >/dev/null; run; sleep 3
wait_panel :1 && ok "recreated computer gets the desktop automatically" || bad "recreated computer has no desktop"
x "grep -q 'digital-layout' ~/.config/rakazo-desktop/primary/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml" && ok "customization kept in a recreated container" || bad "customization lost on recreate"
shot :1 d1-recreated

echo "RESULT: $pass passed, $fail failed"
docker rm -f $C >/dev/null
