// DOM元素引用
const elements = {
    repoList: document.getElementById('repoList'),
    repoStatusList: document.getElementById('repoStatusList'),
    pollInterval: document.getElementById('pollInterval'),
    saveConfig: document.getElementById('saveConfig'),
    startMonitor: document.getElementById('startMonitor'),
    stopMonitor: document.getElementById('stopMonitor'),
    addRepo: document.getElementById('addRepo'),
    statusIndicator: document.getElementById('statusIndicator'),
    monitorStatus: document.getElementById('monitorStatus'),
    lastCheck: document.getElementById('lastCheck'),
    logContainer: document.getElementById('logContainer'),

    // 模态框元素
    repoModal: document.getElementById('repoModal'),
    repoName: document.getElementById('repoName'),
    repoGitUrl: document.getElementById('repoGitUrl'),
    repoBranch: document.getElementById('repoBranch'),
    repoRegistryNamespace: document.getElementById('repoRegistryNamespace'),
    repoImageName: document.getElementById('repoImageName'),
    repoDockerfilePath: document.getElementById('repoDockerfilePath'),
    repoEnabled: document.getElementById('repoEnabled'),
    repoId: document.getElementById('repoId'),
    saveRepoConfig: document.getElementById('saveRepoConfig'),
    triggerBuildModal: document.getElementById('triggerBuildModal'),
    cancelRepoEdit: document.getElementById('cancelRepoEdit'),
    closeModal: document.querySelector('.close')
};

// 初始化
async function init() {
    await loadConfig();
    updateUI(); // 这里调用 updateUI
    attachEventListeners();
    startStatusPolling();
}

// 更新UI界面
function updateUI() {
    console.log('Updating UI...');
    // 这里可以添加UI更新逻辑
    // 例如更新按钮状态等

    // 模拟一些状态更新
    const monitoring = false; // 默认状态
    if (monitoring) {
        elements.startMonitor.disabled = true;
        elements.stopMonitor.disabled = false;
        if (elements.statusIndicator) {
            elements.statusIndicator.className = 'status-indicator status-active';
        }
        if (elements.monitorStatus) {
            elements.monitorStatus.textContent = '运行中';
        }
    } else {
        elements.startMonitor.disabled = false;
        elements.stopMonitor.disabled = true;
        if (elements.statusIndicator) {
            elements.statusIndicator.className = 'status-indicator status-inactive';
        }
        if (elements.monitorStatus) {
            elements.monitorStatus.textContent = '未运行';
        }
    }
}

// 加载配置
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        const config = await response.json();

        elements.pollInterval.value = config.pollInterval || 5;
        renderRepoList(config.repositories);

        addLog('已加载保存的配置', 'info');

        // 加载状态
        await loadStatus();
    } catch (error) {
        addLog('加载配置失败: ' + error.message, 'error');
        console.error('加载配置错误:', error);

        // 即使出错也渲染空仓库列表
        renderRepoList([]);
    }
}

// 加载状态
async function loadStatus() {
    try {
        const response = await fetch('/api/status');
        const status = await response.json();

        updateStatusUI(status);
    } catch (error) {
        console.error('加载状态失败:', error);
    }
}

// 渲染仓库列表
function renderRepoList(repositories) {
    if (!repositories || repositories.length === 0) {
        elements.repoList.innerHTML = `
            <div class="repo-item" data-repo-id="default">
                <div class="repo-header">
                    <h3>新仓库</h3>
                    <div class="repo-actions">
                        <button class="btn-toggle" data-action="toggle">启用</button>
                        <button class="btn-edit" data-action="edit">编辑</button>
                        <button class="btn-delete" data-action="delete">删除</button>
                    </div>
                </div>
                <div class="repo-details">
                    <p><strong>Git地址:</strong> <span class="repo-giturl">未设置</span></p>
                    <p><strong>分支:</strong> <span class="repo-branch">main</span></p>
                    <p><strong>镜像:</strong> <span class="repo-image">未设置</span></p>
                </div>
            </div>
        `;
        return;
    }

    elements.repoList.innerHTML = '';

    repositories.forEach(repo => {
        const repoElement = document.createElement('div');
        repoElement.className = `repo-item ${repo.enabled ? 'active' : ''}`;
        repoElement.dataset.repoId = repo.id;

        repoElement.innerHTML = `
            <div class="repo-header">
                <h3>${repo.name}</h3>
                <div class="repo-actions">
                    <button class="${repo.enabled ? 'btn-danger' : 'btn-success'} btn-toggle" data-action="toggle">
                        ${repo.enabled ? '禁用' : '启用'}
                    </button>
                    <button class="btn-edit" data-action="edit">编辑</button>
                    <button class="btn-delete" data-action="delete">删除</button>
                </div>
            </div>
            <div class="repo-details">
                <p><strong>Git地址:</strong> <span class="repo-giturl">${repo.gitUrl}</span></p>
                <p><strong>分支:</strong> <span class="repo-branch">${repo.branch}</span></p>
                <p><strong>镜像:</strong> <span class="repo-image">${repo.registryNamespace}/${repo.imageName}</span></p>
            </div>
        `;

        elements.repoList.appendChild(repoElement);
    });
}

// 更新状态UI
function updateStatusUI(status) {
    // 更新状态指示器
    if (status.monitoring) {
        elements.statusIndicator.className = 'status-indicator status-active';
        elements.monitorStatus.textContent = '运行中';
    } else {
        elements.statusIndicator.className = 'status-indicator status-inactive';
        elements.monitorStatus.textContent = '未运行';
    }

    // 更新最后检查时间
    elements.lastCheck.textContent = status.lastCheck ? new Date(status.lastCheck).toLocaleString() : '从未';

    // 更新仓库状态
    renderRepoStatus(status.repositories);
}

// 渲染仓库状态
function renderRepoStatus(repositories) {
    if (!repositories || Object.keys(repositories).length === 0) {
        elements.repoStatusList.innerHTML = `
            <div class="repo-status-item">
                <div class="repo-status-header">
                    <h4>暂无仓库状态信息</h4>
                    <span class="status-badge badge-inactive">未监控</span>
                </div>
            </div>
        `;
        return;
    }

    elements.repoStatusList.innerHTML = '';

    // 获取配置以显示仓库名称
    fetch('/api/config')
        .then(response => response.json())
        .then(config => {
            Object.entries(repositories).forEach(([repoId, repoStatus]) => {
                const repoConfig = config.repositories.find(r => r.id === repoId);
                if (!repoConfig) return;

                const statusItem = document.createElement('div');
                statusItem.className = 'repo-status-item';

                // 确定状态徽章
                let statusBadge = 'badge-inactive';
                let statusText = '未监控';

                if (repoStatus.lastBuild) {
                    const lastBuild = repoStatus.buildHistory && repoStatus.buildHistory[0];
                    if (lastBuild) {
                        statusBadge = lastBuild.status === 'success' ? 'badge-success' :
                            lastBuild.status === 'failure' ? 'badge-failure' :
                                lastBuild.status === 'building' ? 'badge-building' : 'badge-inactive';
                        statusText = lastBuild.status === 'success' ? '成功' :
                            lastBuild.status === 'failure' ? '失败' :
                                lastBuild.status === 'building' ? '构建中' : '未知';
                    }
                }

                statusItem.innerHTML = `
                    <div class="repo-status-header">
                        <h4>${repoConfig.name}</h4>
                        <span class="status-badge ${statusBadge}">${statusText}</span>
                    </div>
                    <div class="repo-status-details">
                        <p><strong>最后检查:</strong> ${repoStatus.lastCheck ? new Date(repoStatus.lastCheck).toLocaleString() : '从未'}</p>
                        <p><strong>最后变更:</strong> ${repoStatus.lastChange ? new Date(repoStatus.lastChange).toLocaleString() : '从未'}</p>
                        <p><strong>最后构建:</strong> ${repoStatus.lastBuild ? new Date(repoStatus.lastBuild).toLocaleString() : '从未'}</p>
                    </div>
                    <div class="build-actions">
                        <button class="trigger-build" data-repo-id="${repoId}">立即构建</button>
                    </div>
                    ${repoStatus.buildHistory && repoStatus.buildHistory.length > 0 ? `
                    <div class="build-history">
                        <h5>最近构建记录</h5>
                        ${repoStatus.buildHistory.slice(0, 3).map(build => `
                            <div class="history-item">
                                <span>${new Date(build.date).toLocaleString()}</span>
                                <span class="status-badge ${build.status === 'success' ? 'badge-success' :
                    build.status === 'failure' ? 'badge-failure' :
                        'badge-building'}">
                                    ${build.status === 'success' ? '成功' :
                    build.status === 'failure' ? '失败' : '构建中'}
                                </span>
                            </div>
                        `).join('')}
                    </div>
                    ` : ''}
                `;

                elements.repoStatusList.appendChild(statusItem);
            });

            // 添加立即构建按钮的事件监听
            document.querySelectorAll('.trigger-build').forEach(button => {
                button.addEventListener('click', function() {
                    const repoId = this.dataset.repoId;
                    triggerBuild(repoId);
                });
            });
        });
}

// 保存配置
async function saveConfig() {
    // 先获取当前配置
    const response = await fetch('/api/config');
    const currentConfig = await response.json();

    const config = {
        ...currentConfig,
        pollInterval: parseInt(elements.pollInterval.value)
    };

    try {
        const saveResponse = await fetch('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(config)
        });

        const result = await saveResponse.json();
        addLog('配置已保存', 'success');
    } catch (error) {
        addLog('保存配置失败: ' + error.message, 'error');
    }
}

// 开始监控
async function startMonitoring() {
    try {
        const response = await fetch('/api/monitor/start', {
            method: 'POST'
        });

        const result = await response.json();
        addLog(result.message, 'success');
        await loadStatus();
    } catch (error) {
        addLog('启动监控失败: ' + error.message, 'error');
    }
}

// 停止监控
async function stopMonitoring() {
    try {
        const response = await fetch('/api/monitor/stop', {
            method: 'POST'
        });

        const result = await response.json();
        addLog(result.message, 'info');
        await loadStatus();
    } catch (error) {
        addLog('停止监控失败: ' + error.message, 'error');
    }
}

// 触发构建
async function triggerBuild(repoId) {
    try {
        const response = await fetch(`/api/build/trigger/${repoId}`, {
            method: 'POST'
        });

        const result = await response.json();
        addLog(`仓库构建已触发: ${result.imageTag}`, 'info');
        await loadStatus();
    } catch (error) {
        addLog('触发构建失败: ' + error.message, 'error');
    }
}

// 打开编辑仓库模态框
function openRepoModal(repo = null) {
    if (repo) {
        elements.repoName.value = repo.name || '';
        elements.repoGitUrl.value = repo.gitUrl || '';
        elements.repoBranch.value = repo.branch || 'main';
        elements.repoRegistryNamespace.value = repo.registryNamespace || '';
        elements.repoImageName.value = repo.imageName || '';
        elements.repoDockerfilePath.value = repo.dockerfilePath || './Dockerfile';
        elements.repoEnabled.checked = repo.enabled !== false;
        elements.repoId.value = repo.id || '';
    } else {
        // 清空表单
        elements.repoName.value = '';
        elements.repoGitUrl.value = '';
        elements.repoBranch.value = 'main';
        elements.repoRegistryNamespace.value = '';
        elements.repoImageName.value = '';
        elements.repoDockerfilePath.value = './Dockerfile';
        elements.repoEnabled.checked = true;
        elements.repoId.value = '';
    }

    elements.repoModal.style.display = 'block';
}

// 保存仓库配置
async function saveRepoConfig() {
    const repo = {
        id: elements.repoId.value || 'repo-' + Date.now(),
        name: elements.repoName.value,
        gitUrl: elements.repoGitUrl.value,
        branch: elements.repoBranch.value,
        registryNamespace: elements.repoRegistryNamespace.value,
        imageName: elements.repoImageName.value,
        dockerfilePath: elements.repoDockerfilePath.value,
        enabled: elements.repoEnabled.checked
    };

    // 先获取当前配置
    const response = await fetch('/api/config');
    const config = await response.json();

    let repositories = config.repositories || [];

    if (elements.repoId.value) {
        // 更新现有仓库
        const index = repositories.findIndex(r => r.id === elements.repoId.value);
        if (index !== -1) {
            repositories[index] = repo;
        }
    } else {
        // 添加新仓库
        repositories.push(repo);
    }

    // 保存更新后的配置
    const updatedConfig = {
        ...config,
        repositories: repositories
    };

    try {
        const saveResponse = await fetch('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatedConfig)
        });

        const result = await saveResponse.json();
        addLog('仓库配置已保存', 'success');
        closeRepoModal();
        await loadConfig();
    } catch (error) {
        addLog('保存仓库配置失败: ' + error.message, 'error');
    }
}

// 关闭仓库模态框
function closeRepoModal() {
    elements.repoModal.style.display = 'none';
}

// 删除仓库
async function deleteRepo(repoId) {
    // 先获取当前配置
    const response = await fetch('/api/config');
    const config = await response.json();

    const repositories = (config.repositories || []).filter(r => r.id !== repoId);

    // 保存更新后的配置
    const updatedConfig = {
        ...config,
        repositories: repositories
    };

    try {
        const saveResponse = await fetch('/api/config', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatedConfig)
        });

        const result = await saveResponse.json();
        addLog('仓库已删除', 'success');
        await loadConfig();
    } catch (error) {
        addLog('删除仓库失败: ' + error.message, 'error');
    }
}

// 切换仓库启用状态
async function toggleRepo(repoId) {
    // 先获取当前配置
    const response = await fetch('/api/config');
    const config = await response.json();

    const repositories = config.repositories || [];
    const repoIndex = repositories.findIndex(r => r.id === repoId);

    if (repoIndex !== -1) {
        repositories[repoIndex].enabled = !repositories[repoIndex].enabled;

        // 保存更新后的配置
        const updatedConfig = {
            ...config,
            repositories: repositories
        };

        try {
            const saveResponse = await fetch('/api/config', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(updatedConfig)
            });

            const result = await saveResponse.json();
            addLog(`仓库已${repositories[repoIndex].enabled ? '启用' : '禁用'}`, 'success');
            await loadConfig();
        } catch (error) {
            addLog('更新仓库状态失败: ' + error.message, 'error');
        }
    }
}

// 添加日志
function addLog(message, type = 'info') {
    const logEntry = document.createElement('div');
    logEntry.className = `log-entry log-${type}`;
    logEntry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    elements.logContainer.appendChild(logEntry);
    elements.logContainer.scrollTop = elements.logContainer.scrollHeight;
}

// 启动状态轮询
function startStatusPolling() {
    setInterval(async () => {
        await loadStatus();
    }, 5000); // 每5秒更新一次状态
}

// 附加事件监听器
function attachEventListeners() {
    elements.saveConfig.addEventListener('click', saveConfig);
    elements.startMonitor.addEventListener('click', startMonitoring);
    elements.stopMonitor.addEventListener('click', stopMonitoring);
    elements.addRepo.addEventListener('click', () => openRepoModal());
    elements.saveRepoConfig.addEventListener('click', saveRepoConfig);
    elements.triggerBuildModal.addEventListener('click', () => {
        if (elements.repoId.value) {
            triggerBuild(elements.repoId.value);
        }
    });
    elements.cancelRepoEdit.addEventListener('click', closeRepoModal);
    elements.closeModal.addEventListener('click', closeRepoModal);

    // 点击模态框外部关闭
    window.addEventListener('click', (event) => {
        if (event.target === elements.repoModal) {
            closeRepoModal();
        }
    });

    // 仓库列表事件委托
    elements.repoList.addEventListener('click', (event) => {
        const target = event.target;
        const repoItem = target.closest('.repo-item');
        if (!repoItem) return;

        const repoId = repoItem.dataset.repoId;
        if (repoId === 'default') {
            openRepoModal();
            return;
        }

        if (target.classList.contains('btn-edit')) {
            // 获取仓库配置
            fetch('/api/config')
                .then(response => response.json())
                .then(config => {
                    const repo = config.repositories.find(r => r.id === repoId);
                    if (repo) {
                        openRepoModal(repo);
                    }
                });
        } else if (target.classList.contains('btn-delete')) {
            if (confirm('确定要删除这个仓库吗？')) {
                deleteRepo(repoId);
            }
        } else if (target.classList.contains('btn-toggle')) {
            toggleRepo(repoId);
        }
    });
}

// 初始化应用
init();