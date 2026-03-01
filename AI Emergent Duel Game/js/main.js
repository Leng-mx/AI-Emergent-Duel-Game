import { Game } from './game.js';

function showRuntimeNotice(message, level = 'danger') {
    let holder = document.getElementById('runtime-notice');
    if (!holder) {
        holder = document.createElement('div');
        holder.id = 'runtime-notice';
        holder.className = `ui-notice ${level}`;
        holder.style.zIndex = '1700';
        document.body.appendChild(holder);
    }
    holder.textContent = String(message || '');
    holder.className = `ui-notice ${level}`;
    holder.classList.remove('hidden');
}

// 检查运行环境
if (window.location.protocol === 'file:') {
    const msg = "⚠️ 警告：检测到您正在直接打开 HTML 文件 (file://)。\n\n该项目现在包含前后端联动，必须通过本地 Node 服务运行。\n\n请使用以下方式启动：\n1. 双击 start-local.bat\n2. 终端运行 'node server.js'\n\n然后访问: http://localhost:8787";
    console.error(msg);
    showRuntimeNotice("错误：请使用本地服务器运行此游戏 (localhost)，而不是直接打开文件。", 'danger');
}

// 启动游戏
window.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Loaded, initializing Game...");
    try {
        window.game = new Game(); // Expose to window for debugging if needed
        console.log("Game instance created.");
    } catch (e) {
        console.error("Critical Error during Game initialization:", e);
        showRuntimeNotice("游戏初始化失败，请查看控制台 (F12) 获取详情。", 'danger');
    }
});
