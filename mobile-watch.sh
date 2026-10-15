#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$DIR/server.pid"
LOG_FILE="$DIR/server.log"
# Detect node_modules directory for optional modules (qrcode, etc.)
NP_DIR="${HERMES_NODE_MODULES:-}"
if [ -z "$NP_DIR" ] || [ ! -d "$NP_DIR" ]; then
  for cand in "$DIR/node_modules" "$DIR/../hermes-web-ui-pereview/node_modules" "$DIR/../node_modules"; do
    if [ -d "$cand" ]; then
      NP_DIR="$cand"
      break
    fi
  done
fi

# Detect hermes-web-ui dist/client/index.html locations
get_client_index_paths() {
  local paths=()
  # 1. Inspect running hermes-web-ui process (highest priority)
  local proc_path
  proc_path=$(ps aux 2>/dev/null | grep -v grep | grep 'hermes-web-ui/dist/server/index.js' | head -n 1 | awk '{for(i=1;i<=NF;i++) if($i ~ /hermes-web-ui\/dist\/server\/index\.js/) print $i}')
  if [ -n "$proc_path" ]; then
    local client_index="${proc_path/dist\/server\/index.js/dist\/client\/index.html}"
    if [ -f "$client_index" ]; then
      paths+=("$client_index")
    fi
  fi

  # 2. From environment variable HERMES_WEB_UI_INDEX
  if [ -n "${HERMES_WEB_UI_INDEX:-}" ] && [ -f "$HERMES_WEB_UI_INDEX" ]; then
    paths+=("$HERMES_WEB_UI_INDEX")
  fi

  # 3. All matching dist/client/index.html in ~/.npm/_npx
  if [ -d "$HOME/.npm/_npx" ]; then
    while IFS= read -r f; do
      [ -n "$f" ] && [ -f "$f" ] && paths+=("$f")
    done < <(find "$HOME/.npm/_npx" -name "index.html" -path "*/hermes-web-ui/dist/client/index.html" 2>/dev/null)
  fi

  # 4. Global npm root
  local global_npm
  global_npm=$(npm root -g 2>/dev/null || true)
  if [ -n "$global_npm" ] && [ -f "$global_npm/hermes-web-ui/dist/client/index.html" ]; then
    paths+=("$global_npm/hermes-web-ui/dist/client/index.html")
  fi

  # 5. Local repo dist
  if [ -f "$DIR/../dist/client/index.html" ]; then
    paths+=("$DIR/../dist/client/index.html")
  fi

  if [ ${#paths[@]} -gt 0 ]; then
    printf '%s\n' "${paths[@]}" | sort -u
  fi
}

start_server() {
  echo "🚀 正在启动 Hermes Mobile Watch 伴侣服务..."
  # Auto-inject companion widget into Hermes Web UI
  install_widget >/dev/null 2>&1 || true

  if systemctl --user start hermes-mobile-watch 2>/dev/null; then
    :
  else
    node "$DIR/daemon.mjs"
  fi
  sleep 1.5

  if curl -s -f http://127.0.0.1:8649/api/info >/dev/null 2>&1; then
    echo "✅ 启动成功!"
    echo "📄 日志文件: $LOG_FILE"
    echo ""
    show_qr
    return 0
  fi
  echo "❌ 启动失败，请检查日志: $LOG_FILE"
  cat "$LOG_FILE" | tail -n 20
  exit 1
}

stop_server() {
  if systemctl --user is-active hermes-mobile-watch 2>/dev/null; then
    echo "🛑 正在停止 systemd 伴侣服务..."
    systemctl --user stop hermes-mobile-watch
  fi
  if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if kill -0 "$PID" 2>/dev/null; then
      echo "🛑 正在停止伴侣服务进程 (PID: $PID)..."
      kill "$PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
  fi
  echo "✅ 伴侣服务已停止"
}

check_status() {
  INFO=$(curl -s -m 2 http://127.0.0.1:8649/api/info 2>/dev/null || true)
  if [ -n "$INFO" ] && echo "$INFO" | grep -q "lanUrl"; then
    echo "🟢 Hermes Mobile Watch 正在运行"
    echo "$INFO" | node -e "
      let d = '';
      process.stdin.on('data', c => d += c);
      process.stdin.on('end', () => {
        try {
          const j = JSON.parse(d);
          console.log('📡 局域网访问地址: ' + j.lanUrl);
          console.log('🔗 Hermes 核心连接: ' + (j.hermesConnected ? '已连接' : '未连接'));
          console.log('📱 手机连接数:     ' + j.connectedMobileClients);
          console.log('⚠️ 待审批任务数:   ' + j.activeApprovalsCount);
        } catch(e) {}
      });
    "
    return 0
  fi
  echo "🔴 Hermes Mobile Watch 未在运行"
}

show_qr() {
  NODE_PATH="$NP_DIR" node -e "
    const os = require('os');
    const ifaces = os.networkInterfaces();
    const candidates = [];
    for (const [name, addrs] of Object.entries(ifaces)) {
      for (const addr of addrs || []) {
        if (addr.family === 'IPv4' && !addr.internal) {
          candidates.push(addr.address);
        }
      }
    }
    const ip = candidates.find(a => a.startsWith('192.168.')) ||
               candidates.find(a => a.startsWith('10.') && !a.startsWith('10.255.')) ||
               candidates.find(a => a.startsWith('172.')) ||
               candidates[0] || 'localhost';
    const url = 'http://' + ip + ':8649';
    console.log('==================================================');
    console.log('📱 手机请连接同一 Wi-Fi，打开微信/浏览器访问看护地址:');
    console.log('👉 直达链接: ' + url);
    try {
      const QRCode = require('qrcode');
      QRCode.toString(url, { type: 'terminal', small: true }, (err, text) => {
        if (!err && text) {
          console.log('\n📱 手机扫码直达:');
          console.log(text);
        }
        console.log('==================================================');
      });
    } catch {
      console.log('💡 提示: 在手机浏览器直接输入上方直达链接即可访问');
      console.log('==================================================');
    }
  "
}

install_widget() {
  local target_paths
  mapfile -t target_paths < <(get_client_index_paths)
  if [ ${#target_paths[@]} -eq 0 ] || [ -z "${target_paths[0]:-}" ]; then
    echo "⚠️ 未找到 hermes-web-ui 的 index.html，跳过挂件注入"
    return 0
  fi

  for target in "${target_paths[@]}"; do
    [ -n "$target" ] && [ -f "$target" ] || continue
    local backup="${target}.original"
    if [ -f "$backup" ]; then
      cp "$backup" "$target"
    else
      cp "$target" "$backup"
      echo "📦 已备份原始 PC 页面至: $backup"
    fi

    node -e "
      const fs = require('fs');
      const target = process.argv[1];
      const widgetCode = fs.readFileSync('$DIR/public/companion-widget.js', 'utf8');
      let html = fs.readFileSync(target, 'utf8');
      const markerStart = '<!-- HERMES_WATCH_WIDGET_START -->';
      const markerEnd = '<!-- HERMES_WATCH_WIDGET_END -->';
      const widgetBlock = markerStart + '\n<script>\n' + widgetCode + '\n</script>\n' + markerEnd;
      
      if (html.includes(markerStart)) {
        const regex = /<!-- HERMES_WATCH_WIDGET_START -->[\s\S]*?<!-- HERMES_WATCH_WIDGET_END -->/;
        html = html.replace(regex, widgetBlock);
      } else {
        html = html.replace('</body>', widgetBlock + '\n</body>');
      }
      fs.writeFileSync(target, html, 'utf8');
    " "$target"
    echo "✅ 已成功将手机与桌面看护挂件注入到: $target"
  done
  echo "💡 刷新电脑浏览器 http://localhost:8648 即可生效"
}

uninstall_widget() {
  local target_paths
  mapfile -t target_paths < <(get_client_index_paths)
  for target in "${target_paths[@]}"; do
    [ -n "$target" ] && [ -f "$target" ] || continue
    local backup="${target}.original"
    if [ -f "$backup" ]; then
      cp "$backup" "$target"
      echo "✅ 已成功从备份恢复 PC 页面: $target"
    elif [ -f "$target" ]; then
      node -e "
        const fs = require('fs');
        const target = process.argv[1];
        let html = fs.readFileSync(target, 'utf8');
        const regex = /<!-- HERMES_WATCH_WIDGET_START -->[\s\S]*?<!-- HERMES_WATCH_WIDGET_END -->/;
        html = html.replace(regex, '');
        fs.writeFileSync(target, html, 'utf8');
      " "$target"
      echo "✅ 已移除挂件脚本: $target"
    fi
  done
}

case "$1" in
  start)
    start_server
    ;;
  stop)
    stop_server
    ;;
  restart)
    stop_server
    sleep 1
    start_server
    ;;
  status)
    check_status
    ;;
  qr)
    show_qr
    ;;
  install-widget)
    install_widget
    ;;
  uninstall-widget)
    uninstall_widget
    ;;
  *)
    echo "使用方法: $0 {start|stop|restart|status|qr|install-widget|uninstall-widget}"
    exit 1
    ;;
esac
