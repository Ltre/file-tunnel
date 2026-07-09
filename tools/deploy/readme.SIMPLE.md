到服务器执行以下：

cd ~/mydir/pre-deploy/file-tunnel-deploy # 假定已经 【git clone https://github.com/Ltre/file-tunnel】 到此目录
git pull
bash tools/deploy/release.sh --source dev/2607A-NEWCODE  --profile txhk  # "dev/2607A-NEWCODE"是某个被选择发布的分支， "txhk"是某个机器的别名

构建后的代码位于类似于这样 ".deploy-worktrees/deploy-txhk/dist" 的目录中