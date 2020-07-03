## run with sudo ##

# Install tools
apt install curl
apt install git
apt install vim
apt install bat
apt install fzf
apt install tmux

# Install tmux plugin manager (Hit `prefix + I` to setup plugins specified in `tmux.conf`)
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm

# Install terminal
add-apt-repository ppa:mmstick76/alacritty
apt install alacritty

# Install shell (zsh) and set as default
apt install zsh
chsh -s /bin/zsh
sh -c "$(curl -fsSL https://raw.github.com/robbyrussell/oh-my-zsh/master/tools/install.sh)"
git clone https://github.com/romkatv/powerlevel10k.git  ~/.oh-my-zsh/custom/themes/powerlevel10k
git clone https://github.com/zsh-users/zsh-completions ~/.oh-my-zsh/custom/plugins/zsh-completions
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ~/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting
git clone https://github.com/zsh-users/zsh-autosuggestions ~/.oh-my-zsh/custom/plugins/zsh-autosuggestions

# Symlink dotfiles
./create-links.sh
