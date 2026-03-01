const sessionInput = document.getElementById('session-input');
const loadBtn = document.getElementById('load-report-btn');
const statusEl = document.getElementById('status');
const summaryEl = document.getElementById('summary');
const allyEl = document.getElementById('ally-history');
const enemyEl = document.getElementById('enemy-history');

function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.style.color = isError ? '#ff8b8b' : '#9ecfe2';
}

function clearContainers() {
    summaryEl.innerHTML = '';
    allyEl.innerHTML = '';
    enemyEl.innerHTML = '';
}

function card(title, value) {
    const div = document.createElement('article');
    div.className = 'mini-card';
    div.innerHTML = `<h3>${title}</h3><p>${value}</p>`;
    return div;
}

function renderHistory(container, titlePrefix, history) {
    container.innerHTML = '';
    if (!Array.isArray(history) || history.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'history-item';
        empty.textContent = '暂无记录';
        container.appendChild(empty);
        return;
    }

    history.forEach((item) => {
        const block = document.createElement('div');
        block.className = 'history-item';
        const lines = Array.isArray(item.trace) ? item.trace : [];
        const linesHtml = lines.map((line) => `<li>${line}</li>`).join('');
        block.innerHTML = `
            <h4>${titlePrefix} 第 ${item.round} 回合</h4>
            <ul>${linesHtml}</ul>
        `;
        container.appendChild(block);
    });
}

async function loadReport(sessionId) {
    if (!sessionId) {
        setStatus('请先输入会话 ID', true);
        return;
    }

    clearContainers();
    setStatus('正在加载战报...');

    try {
        const res = await fetch(`/api/session/${encodeURIComponent(sessionId)}/report`);
        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || `加载失败 (${res.status})`);
        }

        summaryEl.classList.remove('hidden');
        summaryEl.appendChild(card('会话ID', data.sessionId));
        summaryEl.appendChild(card('玩家', `${data.playerProfile.name} (${data.playerProfile.role})`));
        summaryEl.appendChild(card('总积分', `${data.score.player} : ${data.score.enemy}`));
        summaryEl.appendChild(card('胜者', data.winner === 'draw' ? '平局' : (data.winner === 'player' ? '玩家阵营' : '敌方阵营')));
        summaryEl.appendChild(card('回合数', `${data.totalRounds}/${data.match.maxRounds}`));
        const settlement = data?.victory?.settlement;
        if (settlement) {
            summaryEl.appendChild(card('十轮清算胜点', `${settlement.victoryPoints.player} : ${settlement.victoryPoints.enemy}`));
            const detail = (settlement.breakdown || [])
                .map((row) => `${row.label}(${row.player}:${row.enemy})`)
                .join(' / ');
            summaryEl.appendChild(card('清算维度', detail || '无'));
        }

        renderHistory(allyEl, '我方 Director', data.allyDirectorHistory);
        renderHistory(enemyEl, '敌方 Director', data.enemyDirectorHistory);
        setStatus('战报加载成功');
    } catch (e) {
        setStatus(e.message, true);
    }
}

loadBtn.addEventListener('click', () => loadReport(sessionInput.value.trim()));
sessionInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') loadReport(sessionInput.value.trim());
});

const initialSession = new URLSearchParams(window.location.search).get('session');
if (initialSession) {
    sessionInput.value = initialSession;
    loadReport(initialSession);
}
