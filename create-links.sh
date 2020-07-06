
#!/bin/bash

echo ""
echo "Setting up gitconfig links"
gitconfig=~/.gitconfig
[ -e "$gitconfig" ] && rm "$gitconfig"
ln -s ~/dotfiles/git/gitconfig "$gitconfig"
ls -al "$gitconfig"

echo ""
echo "Setting up gitignore links"
gitignore=~/.gitignore
[ -e "$gitignore" ] && rm "$gitignore"
ln -s ~/dotfiles/git/gitignore "$gitignore"
ls -al "$gitignore"

echo ""
echo "Setting up p10k links"
p10k=~/.p10k.zsh
[ -e "$p10k" ] && rm "$p10k"
ln -s ~/dotfiles/zsh/p10k.zsh "$p10k"
ls -al "$p10k"

echo ""
echo "Setting up zsh links"
zsh=~/.zshrc
[ -e "$zsh" ] && rm "$zsh"
ln -s ~/dotfiles/zsh/zshrc "$zsh"
ls -al "$zsh"

echo ""
echo "Setting up tmux links"
tmux=~/.tmux.conf
[ -e "$tmux" ] && rm "$tmux"
ln -s ~/dotfiles/tmux/tmux.conf "$tmux"
ls -al "$tmux"

echo ""
echo "Setting up vim links"
vim=~/.vimrc
[ -e "$vim" ] && rm "$vim"
ln -s ~/dotfiles/vim/vimrc "$vim"
ls -al "$vim"

echo ""
echo "Setting up alacritty links"
mkdir -p ~/.config/alacritty/
alacritty=~/.config/alacritty/alacritty.yml
[ -e "$alacritty" ] && rm "$alacritty"
ln -s ~/dotfiles/alacritty/alacritty.yml "$alacritty"
ls -al "$alacritty"
