## Install Homebrew before running ##
# /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# Install tools
brew install cask
brew install diff-so-fancy
brew install bat
brew install fzf
brew install tmux
curl -L https://git.io/tmux-up -o /usr/local/bin/tmux-up

# Install "Tmux Plugin Manager" Hit `prefix + I` to setup plugins specified in `tmux.conf`
git clone https://github.com/tmux-plugins/tpm ~/.tmux/plugins/tpm

# Install terminal
brew install --cask alacritty

# Install shell (zsh) and set as default
brew install zsh
sudo chsh -s /bin/zsh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"
git clone https://github.com/romkatv/powerlevel10k.git  ~/.oh-my-zsh/custom/themes/powerlevel10k
git clone https://github.com/zsh-users/zsh-autosuggestions ~/.oh-my-zsh/custom/plugins/zsh-autosuggestions
git clone https://github.com/zsh-users/zsh-completions ~/.oh-my-zsh/custom/plugins/zsh-completions
git clone https://github.com/zsh-users/zsh-syntax-highlighting.git ~/.oh-my-zsh/custom/plugins/zsh-syntax-highlighting

# Symlink dotfiles
./create-links.sh
