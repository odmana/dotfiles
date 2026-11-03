## run with sudo ##

# Install tools
apt install curl
apt install git
apt install vim
apt install bat
apt install fzf

# Install terminal
add-apt-repository ppa:mmstick76/alacritty
apt install alacritty

# Install zsh if missing, and make it the default shell if it isn't already.
# Runs under sudo, so change the invoking user's shell rather than root's.
command -v zsh >/dev/null || apt install zsh
user="${SUDO_USER:-$USER}"
case "$(getent passwd "$user" | cut -d: -f7)" in
  */zsh) ;;
  *) chsh -s "$(command -v zsh)" "$user" ;;
esac
apt install zsh-autosuggestions zsh-syntax-highlighting zoxide
# starship is packaged from Ubuntu 25.04 / Debian 13; on older releases see https://starship.rs/guide/#step-1-install-starship
apt install starship

# Symlink dotfiles
./create-links.sh
