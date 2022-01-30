//SPDX-License-Identifier: Unlicense
pragma solidity ^0.8.0;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IStatikMaster {
    function redeem(uint256 amount) external;

    function claimUsdc(uint256 amountOutMin) external;
}

interface IRouter {
    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata PATH,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

contract StatikArb is Ownable {
    using SafeERC20 for IERC20;
    uint256 private constant MAXINT = type(uint256).max;
    IStatikMaster private constant STATIKMASTER =
        IStatikMaster(0x3D4186902BE316B1870e57bf9f4CEd37bDd0087A);
    IRouter private constant THOROUTER =
        IRouter(0xb5b2444eDF79b00d40f463f79158D1187a0D0c25);
    address[] private PATH = [
        address(0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664),
        address(0x97d367A5f900F5c9dB4370D0D801Fc52332244C7)
    ];
    IERC20 private constant USDC =
        IERC20(0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664);
    IERC20 private constant STATIK =
        IERC20(0x97d367A5f900F5c9dB4370D0D801Fc52332244C7);

    constructor() {
        USDC.safeApprove(address(THOROUTER), MAXINT);
        STATIK.safeApprove(address(STATIKMASTER), MAXINT);
    }

    function swapAndRedeem(uint256 usdcAmount, uint256 minStatikAmount)
        external
        onlyOwner
    {
        USDC.safeTransferFrom(address(msg.sender), address(this), usdcAmount);
        _swapUsdcToStatik(usdcAmount, minStatikAmount);
        _redeem(STATIK.balanceOf(address(this)));
    }

    function claim(uint256 minUsdcFromTho, uint256 minUsdcFromShare) external onlyOwner {
        _claim(minUsdcFromTho, minUsdcFromShare);
        USDC.safeTransfer(address(msg.sender), USDC.balanceOf(address(this)));
    }

    function swapUsdcToStatik(uint256 usdcAmount, uint256 minStatikAmount)
        external
        onlyOwner
        returns (uint256[] memory)
    {
        return _swapUsdcToStatik(usdcAmount, minStatikAmount);
    }

    function redeem(uint256 statikAmount) external onlyOwner {
        _redeem(statikAmount);
    }

    function returnToken(address token, address destination)
        external
        onlyOwner
    {
        _transferToken(token, destination);
    }

    function _swapUsdcToStatik(uint256 usdcAmount, uint256 minStatikAmount)
        private
        returns (uint256[] memory)
    {
        return
            THOROUTER.swapExactTokensForTokens(
                usdcAmount,
                minStatikAmount,
                PATH,
                address(this),
                block.timestamp
            );
    }

    function _redeem(uint256 statikAmount) private {
        STATIKMASTER.redeem(statikAmount);
    }

    function _claim(uint256 minUsdcFromTho, uint256 minUsdcFromShare) private {
        STATIKMASTER.claimUsdc(minUsdcFromTho, minUsdcFromShare);
    }

    function _transferToken(address token, address destination) private {
        IERC20(token).safeTransfer(
            destination,
            IERC20(token).balanceOf(address(this))
        );
    }
}
