let activeInfoHash = null;
let statusInterval = null;

async function convertTorrent() {
    const input = document.getElementById('torrentUrl').value.trim();
    const errorMessage = document.getElementById('errorMessage');
    const torrentDetails = document.getElementById('torrentDetails');
    const btnText = document.getElementById('btnText');
    const btnSpinner = document.getElementById('btnSpinner');

    if (!input) {
        showError('Please paste a YTS torrent link, magnet URI, or torrent file URL.');
        return;
    }

    showError(null);
    btnText.classList.add('hidden');
    btnSpinner.classList.remove('hidden');

    try {
        const response = await fetch('/api/convert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: input })
        });

        const data = await response.json();

        if (!response.ok || data.error) {
            throw new Error(data.error || 'Failed to convert torrent link');
        }

        activeInfoHash = data.infoHash;
        renderTorrentDetails(data);
        startStatusPolling(data.infoHash);

    } catch (err) {
        showError(err.message || 'Could not connect to conversion server.');
    } finally {
        btnText.classList.remove('hidden');
        btnSpinner.classList.add('hidden');
    }
}

function renderTorrentDetails(data) {
    document.getElementById('torrentTitle').textContent = data.name || 'Torrent Download';
    document.getElementById('torrentSize').textContent = formatBytes(data.totalSize || 0);

    const fileList = document.getElementById('fileList');
    fileList.innerHTML = '';

    const host = window.location.origin;

    data.files.forEach(file => {
        const fullDownloadUrl = `${host}${file.downloadLink}`;
        const fullStreamUrl = `${host}${file.streamLink}`;

        const item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML = `
            <div class="file-info">
                <span class="file-name" title="${file.name}">${file.name}</span>
                <span class="file-size">${formatBytes(file.length)}</span>
            </div>
            <div class="file-actions">
                <button onclick="copyToClipboard('${fullDownloadUrl}', this)" class="btn-action btn-stream">Copy Direct Link</button>
                <a href="${fullStreamUrl}" target="_blank" class="btn-action btn-stream">Stream</a>
                <a href="${fullDownloadUrl}" target="_blank" download="${file.name}" class="btn-action btn-download">Download</a>
            </div>
        `;
        fileList.appendChild(item);
    });

    document.getElementById('torrentDetails').classList.remove('hidden');
}

function copyToClipboard(text, btnElement) {
    navigator.clipboard.writeText(text).then(() => {
        const originalText = btnElement.textContent;
        btnElement.textContent = 'Copied!';
        setTimeout(() => {
            btnElement.textContent = originalText;
        }, 2000);
    }).catch(err => {
        console.error('Failed to copy: ', err);
    });
}

function startStatusPolling(infoHash) {
    if (statusInterval) clearInterval(statusInterval);

    statusInterval = setInterval(async () => {
        try {
            const res = await fetch(`/api/status/${infoHash}`);
            if (!res.ok) return;
            const status = await res.json();

            document.getElementById('progressText').textContent = `${(status.progress * 100).toFixed(1)}%`;
            document.getElementById('speedText').textContent = `${formatBytes(status.downloadSpeed)}/s`;
            document.getElementById('peersText').textContent = status.peers;
            document.getElementById('progressBar').style.width = `${(status.progress * 100).toFixed(1)}%`;

            if (status.progress >= 1) {
                clearInterval(statusInterval);
            }
        } catch (e) {
            console.error('Error fetching status:', e);
        }
    }, 1500);
}

function showError(msg) {
    const errorMessage = document.getElementById('errorMessage');
    if (!msg) {
        errorMessage.classList.add('hidden');
        errorMessage.textContent = '';
    } else {
        errorMessage.textContent = msg;
        errorMessage.classList.remove('hidden');
    }
}

function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}
