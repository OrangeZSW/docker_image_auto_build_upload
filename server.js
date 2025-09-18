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
    pollInterval: 5
};

let state = {
    monitoring: false,
    lastCheck: null,
    repositories: {}
};

// 存储定时器引用（不在状态对象中）
let monitorInterval = null;

// 重试配置
const RETRY_CONFIG = {
    maxRetries: 3,
    retryDelay: 5000, // 5秒
    timeout: 30000    // 30秒超时
};

// 路由 - 获取配置
app.get('/api/config', (req, res) => {
    res.json(config);
});

// 路由 - 保存配置
app.post('/api/config', (req, res) => {
    config = { ...config, ...req.body };
    fs.writeFileSync('config.json', JSON.stringify(config, null, 2));
    res.json({ message: '配置已保存', config });
});

// 路由 - 获取状态（返回可序列化的状态）
app.get('/api/status', (req, res) => {
    // 创建一个可序列化的状态副本
    const serializableState = {
        monitoring: state.monitoring,
        lastCheck: state.lastCheck,
        repositories: { ...state.repositories }
    };

    res.json(serializableState);
});

// 路由 - 开始监控
app.post('/api/monitor/start', (req, res) => {
    if (state.monitoring) {
        return res.status(400).json({ message: '监控已在运行中' });
    }

    if (config.repositories.length === 0) {
        return res.status(400).json({ message: '请先添加Git仓库' });
    }

    state.monitoring = true;
    // 使用全局变量存储定时器，而不是state对象
    monitorInterval = setInterval(checkAllRepositories, config.pollInterval * 60 * 1000);

    // 立即执行一次检查
    checkAllRepositories();

    res.json({ message: '监控已启动' });
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
app.post('/api/build/trigger/:repoId', (req, res) => {
    const repoId = req.params.repoId;
    const repo = config.repositories.find(r => r.id === repoId);

    if (!repo) {
        return res.status(404).json({ message: '仓库未找到' });
    }

    triggerBuild(repo)
        .then(imageTag => {
            res.json({ message: '构建已触发', imageTag });
        })
        .catch(error => {
            res.status(500).json({ message: '构建触发失败', error: error.message });
        });
});

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

// 检查Git更新 - 修复分支分歧问题
async function checkGitUpdates(repo) {
    try {
        console.log(`[${new Date().toLocaleString()}] 检查仓库: ${repo.name} (${repo.gitUrl})`);

        // 初始化仓库状态
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

        // 克隆或拉取最新代码
        const repoPath = path.join('repos', repo.id);

        // 确保目录存在
        if (!fs.existsSync('repos')) {
            fs.mkdirSync('repos', { recursive: true });
        }

        const gitOperation = async () => {
            if (!fs.existsSync(repoPath)) {
                console.log(`[${new Date().toLocaleString()}] 克隆仓库: ${repo.gitUrl}`);
                await simpleGit().clone(repo.gitUrl, repoPath);

                // 克隆后检查并切换到指定分支
                const git = simpleGit(repoPath);
                const branches = await git.branch({'-a': true});

                // 检查分支是否存在
                const remoteBranchExists = branches.all.includes(`remotes/origin/${repo.branch}`);
                if (remoteBranchExists) {
                    // 创建并切换到跟踪分支
                    await git.checkout(['-b', repo.branch, `origin/${repo.branch}`]);
                    console.log(`[${new Date().toLocaleString()}] 创建并切换到分支: ${repo.branch}`);
                } else {
                    console.log(`[${new Date().toLocaleString()}] 警告: 分支 ${repo.branch} 不存在，使用默认分支`);
                }
            } else {
                const git = simpleGit(repoPath);
                console.log(`[${new Date().toLocaleString()}] 处理仓库: ${repo.gitUrl}`);

                // 获取当前状态
                const status = await git.status();
                const currentBranch = status.current;

                console.log(`[${new Date().toLocaleString()}] 当前分支: ${currentBranch}`);

                // 保存当前更改（如果有）
                try {
                    await git.stash(['save', '--include-untracked', 'Auto-stash by CI system']);
                    console.log(`[${new Date().toLocaleString()}] 已保存未提交的更改`);
                } catch (stashError) {
                    console.log(`[${new Date().toLocaleString()}] 无需要保存的更改`);
                }

                // 确保在正确的分支上
                if (currentBranch !== repo.branch) {
                    try {
                        // 检查远程分支是否存在
                        const branches = await git.branch({'-a': true});
                        const remoteBranchExists = branches.all.includes(`remotes/origin/${repo.branch}`);

                        if (remoteBranchExists) {
                            // 检查本地分支是否存在
                            const localBranchExists = branches.all.includes(repo.branch);

                            if (localBranchExists) {
                                // 切换到现有本地分支
                                await git.checkout(repo.branch);
                                console.log(`[${new Date().toLocaleString()}] 切换到分支: ${repo.branch}`);
                            } else {
                                // 创建新的跟踪分支
                                await git.checkout(['-b', repo.branch, `origin/${repo.branch}`]);
                                console.log(`[${new Date().toLocaleString()}] 创建并切换到跟踪分支: ${repo.branch}`);
                            }
                        } else {
                            throw new Error(`远程分支 ${repo.branch} 不存在`);
                        }
                    } catch (checkoutError) {
                        console.error(`[${new Date().toLocaleString()}] 切换分支失败: ${checkoutError.message}`);
                        // 继续使用当前分支
                    }
                }

                // 获取远程更新信息
                console.log(`[${new Date().toLocaleString()}] 获取远程更新...`);
                await git.fetch('origin');

                // 检查是否有远程更新
                const localCommit = await git.revparse([repo.branch]);
                const remoteCommit = await git.revparse([`origin/${repo.branch}`]);

                if (localCommit !== remoteCommit) {
                    console.log(`[${new Date().toLocaleString()}] 检测到远程有更新，正在同步...`);

                    try {
                        // 方法1: 使用 rebase 策略
                        await git.pull('origin', repo.branch, {'--rebase': 'true'});
                        console.log(`[${new Date().toLocaleString()}] 使用 rebase 策略同步成功`);
                    } catch (rebaseError) {
                        console.log(`[${new Date().toLocaleString()}] rebase 失败，尝试使用 merge 策略: ${rebaseError.message}`);

                        try {
                            // 方法2: 使用 merge 策略（强制）
                            await git.pull('origin', repo.branch, {'--no-ff': 'true'});
                            console.log(`[${new Date().toLocaleString()}] 使用 merge 策略同步成功`);
                        } catch (mergeError) {
                            console.log(`[${new Date().toLocaleString()}] merge 失败，尝试重置分支: ${mergeError.message}`);

                            // 方法3: 强制重置到远程分支
                            await git.reset(['--hard', `origin/${repo.branch}`]);
                            console.log(`[${new Date().toLocaleString()}] 强制重置到远程分支成功`);
                        }
                    }
                } else {
                    console.log(`[${new Date().toLocaleString()}] 分支已是最新，无需更新`);
                }

                // 恢复暂存的更改（如果有）
                try {
                    const stashList = await git.stash(['list']);
                    if (stashList) {
                        await git.stash(['pop']);
                        console.log(`[${new Date().toLocaleString()}] 已恢复暂存的更改`);
                    }
                } catch (stashError) {
                    console.log(`[${new Date().toLocaleString()}] 无暂存可恢复的更改`);
                }
            }
        };

        // 使用重试机制执行Git操作
        await gitOperationWithRetry(gitOperation, repo);

        // 检查是否有新提交
        const git = simpleGit(repoPath);

        // 获取当前分支的最新提交
        const log = await git.log({ n: 1 });

        if (log.latest && (!state.repositories[repo.id].lastChange || new Date(log.latest.date) > state.repositories[repo.id].lastChange)) {
            state.repositories[repo.id].lastChange = new Date();
            console.log(`[${new Date().toLocaleString()}] 检测到新提交: ${repo.name} - ${log.latest.message}`);
            triggerBuild(repo);
        } else {
            console.log(`[${new Date().toLocaleString()}] 没有检测到更新: ${repo.name}`);
        }
    } catch (error) {
        const errorMsg = `检查仓库 ${repo.name} 更新时出错: ${error.message}`;
        console.error(errorMsg);

        // 更新仓库状态为错误
        if (state.repositories[repo.id]) {
            state.repositories[repo.id].lastError = errorMsg;
            state.repositories[repo.id].lastCheck = new Date();
        }
    }
}

// 触发构建 - 修复路径问题
async function triggerBuild(repo) {
    return new Promise((resolve, reject) => {
        const timestamp = new Date().getTime();
        const imageTag = `${config.aliyunRegistry}/${repo.registryNamespace}/${repo.imageName}:${timestamp}`;

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

// 手动测试Git连接
app.post('/api/test-connection/:repoId', async (req, res) => {
    const repoId = req.params.repoId;
    const repo = config.repositories.find(r => r.id === repoId);

    if (!repo) {
        return res.status(404).json({ message: '仓库未找到' });
    }

    try {
        console.log(`[${new Date().toLocaleString()}] 测试连接到: ${repo.gitUrl}`);

        // 使用git ls-remote测试连接
        const testResult = await new Promise((resolve, reject) => {
            exec(`git ls-remote ${repo.gitUrl}`, { timeout: 10000 }, (error, stdout, stderr) => {
                if (error) {
                    reject(error);
                } else {
                    resolve(stdout);
                }
            });
        });

        res.json({
            message: '连接测试成功',
            details: testResult.split('\n').slice(0, 5) // 返回前5行结果
        });
    } catch (error) {
        res.status(500).json({
            message: '连接测试失败',
            error: error.message
        });
    }
});

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
    console.log('当前配置:', JSON.stringify(config, null, 2));
});

// 优雅关闭
process.on('SIGINT', () => {
    console.log('正在关闭服务器...');
    if (monitorInterval) {
        clearInterval(monitorInterval);
    }
    process.exit(0);
});