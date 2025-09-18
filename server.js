const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const simpleGit = require('simple-git');
const app = express();
const port = 3000;

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 存储配置和状态
let config = {
    repositories: [],
    aliyunRegistry: 'registry.cn-hangzhou.aliyuncs.com',
    pollInterval: 5,
    dockerUsername: '',
    dockerPassword: ''
};

let state = {
    monitoring: false,
    lastCheck: null,
    dockerLoggedIn: false,
    repositories: {}
};

// 存储定时器引用
let monitorInterval = null;
const RETRY_CONFIG = { maxRetries: 3, retryDelay: 5000, timeout: 30000 };

// 路由 - 获取配置
app.get('/api/config', (req, res) => {
    res.json(config);
});

// 路由 - 保存配置
app.post('/api/config', (req, res) => {
    // 只更新传递的字段，保持其他字段不变
    Object.keys(req.body).forEach(key => {
        if (req.body[key] !== undefined) {
            config[key] = req.body[key];
        }
    });

    fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
    res.json({ message: '配置已保存', config });
});

// 路由 - 获取状态
app.get('/api/status', (req, res) => {
    const serializableState = {
        monitoring: state.monitoring,
        lastCheck: state.lastCheck,
        dockerLoggedIn: state.dockerLoggedIn,
        repositories: { ...state.repositories }
    };
    res.json(serializableState);
});

// 路由 - 获取单个仓库状态
app.get('/api/repo/:repoId', (req, res) => {
    const repoId = req.params.repoId;
    const repo = config.repositories.find(r => r.id === repoId);
    const repoState = state.repositories[repoId];

    if (!repo || !repoState) {
        return res.status(404).json({ message: '仓库未找到' });
    }

    res.json({
        config: repo,
        state: repoState
    });
});

// 路由 - 测试Docker登录
app.post('/api/docker/login', async (req, res) => {
    const { username, password, registry } = req.body;

    try {
        const loginResult = await dockerLogin(username, password, registry);
        state.dockerLoggedIn = loginResult.success;

        if (loginResult.success) {
            // 保存登录凭证到配置
            config.dockerUsername = username;
            config.dockerPassword = password;
            config.aliyunRegistry = registry;
            fs.writeFileSync('config.json', JSON.stringify(config, null, 2));

            res.json({ message: 'Docker登录成功', loggedIn: true });
        } else {
            res.status(401).json({
                message: 'Docker登录失败',
                error: loginResult.error,
                loggedIn: false
            });
        }
    } catch (error) {
        res.status(500).json({
            message: '登录测试失败',
            error: error.message,
            loggedIn: false
        });
    }
});

// Docker登录函数
async function dockerLogin(username, password, registry) {
    return new Promise((resolve) => {
        if (!username || !password) {
            resolve({ success: false, error: '用户名和密码不能为空' });
            return;
        }

        const loginCommand = `echo '${password}' | docker login --username='${username}' --password-stdin ${registry}`;

        exec(loginCommand, (error, stdout, stderr) => {
            if (error) {
                console.error('Docker登录失败:', stderr || error.message);
                resolve({ success: false, error: stderr || error.message });
            } else {
                console.log('Docker登录成功');
                resolve({ success: true });
            }
        });
    });
}

// 确保Docker已登录
async function ensureDockerLoggedIn() {
    if (state.dockerLoggedIn) {
        return true;
    }

    if (!config.dockerUsername || !config.dockerPassword) {
        throw new Error('Docker用户名或密码未配置');
    }

    const loginResult = await dockerLogin(
        config.dockerUsername,
        config.dockerPassword,
        config.aliyunRegistry
    );

    state.dockerLoggedIn = loginResult.success;
    return loginResult.success;
}

// 路由 - 开始监控
app.post('/api/monitor/start', async (req, res) => {
    if (state.monitoring) {
        return res.status(400).json({ message: '监控已在运行中' });
    }

    if (config.repositories.length === 0) {
        return res.status(400).json({ message: '请先添加Git仓库' });
    }

    try {
        // 检查Docker登录
        const loggedIn = await ensureDockerLoggedIn();
        if (!loggedIn) {
            return res.status(401).json({ message: 'Docker登录失败，请检查凭证' });
        }

        state.monitoring = true;
        monitorInterval = setInterval(checkAllRepositories, config.pollInterval * 60 * 1000);
        checkAllRepositories();

        res.json({ message: '监控已启动' });
    } catch (error) {
        res.status(500).json({ message: '启动监控失败', error: error.message });
    }
});

// 路由 - 停止监控
app.post('/api/monitor/stop', (req, res) => {
    if (!state.monitoring) {
        return res.status(400).json({ message: '监控未运行' });
    }

    state.monitoring = false;
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }
    res.json({ message: '监控已停止' });
});

// 路由 - 触发构建
app.post('/api/build/trigger/:repoId', async (req, res) => {
    const repoId = req.params.repoId;
    const repo = config.repositories.find(r => r.id === repoId);

    if (!repo) {
        return res.status(404).json({ message: '仓库未找到' });
    }

    try {
        // 确保Docker已登录
        const loggedIn = await ensureDockerLoggedIn();
        if (!loggedIn) {
            return res.status(401).json({ message: 'Docker登录失败，无法构建' });
        }

        const imageTag = await triggerBuild(repo);
        res.json({ message: '构建已触发', imageTag });
    } catch (error) {
        res.status(500).json({ message: '构建触发失败', error: error.message });
    }
});

// 检查所有仓库更新
async function checkAllRepositories() {
    try {
        state.lastCheck = new Date();
        console.log(`[${new Date().toLocaleString()}] 检查所有Git仓库更新...`);

        for (const repo of config.repositories) {
            if (repo.enabled) {
                await checkGitUpdates(repo);
            }
        }
    } catch (error) {
        console.error('检查Git更新时出错:', error.message);
    }
}

// 检查Git更新
async function checkGitUpdates(repo) {
    try {
        console.log(`[${new Date().toLocaleString()}] 检查仓库: ${repo.name} (${repo.gitUrl})`);

        if (!state.repositories[repo.id]) {
            state.repositories[repo.id] = {
                lastCheck: null,
                lastChange: null,
                lastBuild: null,
                buildHistory: [],
                lastError: null
            };
        }

        state.repositories[repo.id].lastCheck = new Date();
        state.repositories[repo.id].lastError = null;

        const repoPath = path.join('repos', repo.id);

        if (!fs.existsSync('repos')) {
            fs.mkdirSync('repos', { recursive: true });
        }

        const gitOperation = async () => {
            if (!fs.existsSync(repoPath)) {
                console.log(`[${new Date().toLocaleString()}] 克隆仓库: ${repo.gitUrl}`);
                await simpleGit().clone(repo.gitUrl, repoPath);
            } else {
                const git = simpleGit(repoPath);
                console.log(`[${new Date().toLocaleString()}] 强制同步仓库...`);
                await git.fetch('origin');
                await git.reset(['--hard', `origin/${repo.branch}`]);
            }
        };

        await gitOperationWithRetry(gitOperation, repo);

        const git = simpleGit(repoPath);
        const log = await git.log();

        if (log.latest && (!state.repositories[repo.id].lastChange || new Date(log.latest.date) > state.repositories[repo.id].lastChange)) {
            state.repositories[repo.id].lastChange = new Date();
            console.log(`[${new Date().toLocaleString()}] 检测到新提交: ${repo.name} - ${log.latest.message}`);

            try {
                await ensureDockerLoggedIn();
                await triggerBuild(repo);
            } catch (loginError) {
                console.error(`[${new Date().toLocaleString()}] Docker登录失败，跳过构建: ${loginError.message}`);
            }
        }
    } catch (error) {
        console.error(`检查仓库 ${repo.name} 更新时出错:`, error.message);
    }
}

// 触发构建
async function triggerBuild(repo) {
    return new Promise((resolve, reject) => {
        const timestamp = new Date().getTime();
        const imageTag = `${config.aliyunRegistry}/${repo.registryNamespace}/${repo.imageName}:latest`;

        // 添加构建记录
        const buildRecord = {
            id: timestamp,
            date: new Date(),
            status: 'building',
            image: imageTag
        };

        state.repositories[repo.id].buildHistory.unshift(buildRecord);
        state.repositories[repo.id].lastBuild = new Date();

        console.log(`[${new Date().toLocaleString()}] 开始构建镜像: ${imageTag}`);

        // 检查Dockerfile是否存在
        const repoPath = path.join('repos', repo.id);
        const dockerfilePath = path.join(repoPath, repo.dockerfilePath);

        // 调试信息：显示实际路径
        console.log(`[${new Date().toLocaleString()}] 仓库路径: ${repoPath}`);
        console.log(`[${new Date().toLocaleString()}] Dockerfile路径: ${dockerfilePath}`);

        if (!fs.existsSync(dockerfilePath)) {
            const errorMsg = `Dockerfile不存在: ${dockerfilePath}`;
            console.error(`[${new Date().toLocaleString()}] ${errorMsg}`);

            // 列出目录内容以便调试
            try {
                const files = fs.readdirSync(repoPath);
                console.log(`[${new Date().toLocaleString()}] 仓库文件列表:`, files);

                // 特别检查Dockerfile
                const dockerfileExists = fs.existsSync(path.join(repoPath, 'Dockerfile'));
                console.log(`[${new Date().toLocaleString()}] Dockerfile存在: ${dockerfileExists}`);

                if (dockerfileExists) {
                    const stats = fs.statSync(path.join(repoPath, 'Dockerfile'));
                    console.log(`[${new Date().toLocaleString()}] Dockerfile信息:`, {
                        size: stats.size,
                        mode: stats.mode.toString(8),
                        uid: stats.uid,
                        gid: stats.gid
                    });
                }
            } catch (dirError) {
                console.error(`[${new Date().toLocaleString()}] 无法读取仓库目录: ${dirError.message}`);
            }

            buildRecord.status = 'failure';
            reject(new Error(errorMsg));
            return;
        }

        console.log(`[${new Date().toLocaleString()}] 使用Dockerfile: ${dockerfilePath}`);

        // 读取Dockerfile内容进行调试
        try {
            const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf8');
            console.log(`[${new Date().toLocaleString()}] Dockerfile内容预览:`, dockerfileContent.substring(0, 200) + '...');
        } catch (readError) {
            console.error(`[${new Date().toLocaleString()}] 无法读取Dockerfile: ${readError.message}`);
        }

        // 构建Docker镜像 - 使用绝对路径
        const absoluteDockerfilePath = path.resolve(dockerfilePath);
        const absoluteRepoPath = path.resolve(repoPath);

        console.log(`[${new Date().toLocaleString()}] 绝对路径 - Dockerfile: ${absoluteDockerfilePath}`);
        console.log(`[${new Date().toLocaleString()}] 绝对路径 - 构建上下文: ${absoluteRepoPath}`);

        const dockerBuild = exec(
            `docker build -t ${imageTag} -f "${absoluteDockerfilePath}" "${absoluteRepoPath}"`,
            { timeout: RETRY_CONFIG.timeout },
            (error, stdout, stderr) => {
                if (error) {
                    console.error(`[${new Date().toLocaleString()}] 构建失败: ${error.message}`);
                    console.error(`[${new Date().toLocaleString()}] 构建错误输出: ${stderr}`);
                    buildRecord.status = 'failure';
                    reject(error);
                    return;
                }

                console.log(`[${new Date().toLocaleString()}] 镜像构建成功，开始推送到阿里云仓库...`);
                buildRecord.status = 'success';

                // 推送镜像到阿里云
                const dockerPush = exec(
                    `docker push ${imageTag}`,
                    { timeout: RETRY_CONFIG.timeout },
                    (error, stdout, stderr) => {
                        if (error) {
                            console.error(`[${new Date().toLocaleString()}] 推送失败: ${error.message}`);
                            reject(error);
                            return;
                        }

                        console.log(`[${new Date().toLocaleString()}] 镜像推送成功: ${imageTag}`);
                        resolve(imageTag);
                    }
                );

                dockerPush.stdout.on('data', data => {
                    console.log(data.toString());
                });

                dockerPush.stderr.on('data', data => {
                    console.error(data.toString());
                });
            }
        );

        dockerBuild.stdout.on('data', data => {
            console.log(data.toString());
        });

        dockerBuild.stderr.on('data', data => {
            console.error(data.toString());
        });
    });
}

// 带重试的Git操作
async function gitOperationWithRetry(operation, repo, retryCount = 0) {
    try {
        return await operation();
    } catch (error) {
        if (retryCount < RETRY_CONFIG.maxRetries) {
            console.log(`[${new Date().toLocaleString()}] 操作失败，第${retryCount + 1}次重试...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_CONFIG.retryDelay));
            return await gitOperationWithRetry(operation, repo, retryCount + 1);
        } else {
            throw error;
        }
    }
}

// 加载保存的配置
if (fs.existsSync('config.json')) {
    try {
        const savedConfig = JSON.parse(fs.readFileSync('config.json', 'utf8'));
        config = { ...config, ...savedConfig };
        console.log('配置加载成功');
    } catch (error) {
        console.error('加载配置失败:', error.message);
    }
}

// 确保repos目录存在
if (!fs.existsSync('repos')) {
    fs.mkdirSync('repos', { recursive: true });
}

// 启动服务器
app.listen(port, () => {
    console.log(`多Git仓库监控与自动构建系统运行在 http://localhost:${port}`);
});

process.on('SIGINT', () => {
    console.log('正在关闭服务器...');
    if (monitorInterval) {
        clearInterval(monitorInterval);
    }
    process.exit(0);
});