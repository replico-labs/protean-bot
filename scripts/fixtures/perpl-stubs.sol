// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Stand-ins for Perpl's exchange and DelegatedAccount factory, for scripts/test-perpl-desk.mjs.
// Only what src/desk.js and src/integrations/perpl.js read and call; the ABI shapes follow
// src/integrations/abis/perpl.json and PerplFoundation/delegated-account.

contract TokenStub {
    string public constant name = "Agora USD";
    string public constant symbol = "AUSD";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    error Insufficient();

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address spender, uint256 amount) external returns (bool) { allowance[msg.sender][spender] = amount; return true; }
    function transfer(address to, uint256 amount) external returns (bool) { _move(msg.sender, to, amount); return true; }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] < amount) revert Insufficient();
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }
    function _move(address from, address to, uint256 amount) internal {
        if (balanceOf[from] < amount) revert Insufficient();
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

interface IToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract ExchangeStub {
    struct PositionBitMap { uint256 bank1; uint256 bank2; uint256 bank3; uint256 bank4; }
    struct AccountInfo { uint256 accountId; uint256 balanceCNS; uint256 lockedBalanceCNS; uint8 frozen; address accountAddr; PositionBitMap positions; }
    struct PositionInfo { uint256 accountId; uint256 nextNodeId; uint256 prevNodeId; uint8 positionType; uint256 depositCNS; uint256 pricePNS; uint256 lotLNS; uint256 entryBlock; int256 pnlCNS; int256 deltaPnlCNS; int256 premiumPnlCNS; }
    struct PerpetualInfo {
        string name; string symbol; uint256 priceDecimals; uint256 lotDecimals; bytes32 linkFeedId; uint256 priceTolPer100K; uint256 marginTol; uint256 marginTolDecimals;
        uint256 refPriceMaxAgeSec; uint256 positionBalanceCNS; uint256 insuranceBalanceCNS; uint256 markPNS; uint256 markTimestamp; uint256 lastPNS; uint256 lastTimestamp;
        uint256 oraclePNS; uint256 oracleTimestampSec; uint256 longOpenInterestLNS; uint256 shortOpenInterestLNS; uint256 fundingStartBlock; int16 fundingRatePct100k;
        uint256 absFundingClampPctPer100K; uint8 status; uint256 basePricePNS; uint256 maxBidPriceONS; uint256 minBidPriceONS; uint256 maxAskPriceONS; uint256 minAskPriceONS;
        uint256 numOrders; bool ignOracle;
    }
    struct OrderDesc { uint256 orderDescId; uint256 perpId; uint8 orderType; uint256 orderId; uint256 pricePNS; uint256 lotLNS; uint256 expiryBlock; bool postOnly; bool fillOrKill; bool immediateOrCancel; uint256 maxMatches; uint256 leverageHdths; uint256 lastExecutionBlock; uint256 amountCNS; uint256 maxNegPnlCollatBPS; }
    struct OrderSignature { uint256 perpId; uint256 orderId; }

    error NoAccount(address who);
    error AccountExists();
    error UnknownPerp();
    error TooMuch();

    address public immutable token;
    uint256 public lastId;
    mapping(address => uint256) public idOf;
    mapping(uint256 => AccountInfo) internal accounts;
    mapping(uint256 => mapping(uint256 => PositionInfo)) internal positions;
    mapping(uint256 => PerpetualInfo) internal perps;
    // Every caller of execOrders, for the test: proves the trades came from the desk, not the trader.
    address[] public orderCallers;

    constructor(address _token) { token = _token; }

    /// Test hook: list a market (no constructor storage survives anvil_setCode).
    function listPerp(uint256 perpId, string calldata sym, uint256 priceDecimals, uint256 lotDecimals, uint256 markPNS) external {
        PerpetualInfo storage p = perps[perpId];
        p.name = sym; p.symbol = sym; p.priceDecimals = priceDecimals; p.lotDecimals = lotDecimals; p.markPNS = markPNS; p.status = 1;
    }
    function setMark(uint256 perpId, uint256 markPNS) external { perps[perpId].markPNS = markPNS; }
    function orderCallerCount() external view returns (uint256) { return orderCallers.length; }

    function isHalted() external pure returns (bool) { return false; }
    function whitelistingEnabled() external pure returns (bool) { return false; }
    function whitelisted(address) external pure returns (bool) { return true; }
    function getMinAccountOpenCNS() external pure returns (uint256) { return 10e6; }
    function getExchangeInfo() external view returns (uint256, uint256, uint256, uint256, address, address) { return (0, 0, 0, 6, token, address(0)); }
    function perpetualExists(uint256 perpId) public view returns (bool) { return bytes(perps[perpId].symbol).length > 0; }
    function getPerpetualInfo(uint256 perpId) external view returns (PerpetualInfo memory) { return perps[perpId]; }
    function getMarginFractions(uint256, uint256) external pure returns (uint256, uint256, uint256, uint256, uint256, uint256) { return (2000, 1000, 2000, 0, 0, 0); }

    function getAccountByAddr(address a) external view returns (AccountInfo memory) {
        if (idOf[a] == 0) revert NoAccount(a);
        return accounts[idOf[a]];
    }
    function getPosition(uint256 perpId, uint256 accountId) external view returns (PositionInfo memory, uint256, bool) {
        return (positions[perpId][accountId], perps[perpId].markPNS, true);
    }

    function createAccount(uint256 amount) external returns (uint256 id) {
        if (idOf[msg.sender] != 0) revert AccountExists();
        IToken(token).transferFrom(msg.sender, address(this), amount);
        id = ++lastId;
        idOf[msg.sender] = id;
        AccountInfo storage a = accounts[id];
        a.accountId = id; a.balanceCNS = amount; a.accountAddr = msg.sender;
    }
    function depositCollateral(uint256 amount) external {
        uint256 id = _id();
        IToken(token).transferFrom(msg.sender, address(this), amount);
        accounts[id].balanceCNS += amount;
    }
    function withdrawCollateral(uint256 amount) external {
        uint256 id = _id();
        if (accounts[id].balanceCNS < amount) revert TooMuch();
        accounts[id].balanceCNS -= amount;
        IToken(token).transfer(msg.sender, amount);
    }

    /// Immediate-or-cancel at the limit price: fills in full when the mark is at the limit or better, else nothing.
    /// Closing settles PnL into the balance at the limit price.
    function execOrders(OrderDesc[] calldata descs, bool) external returns (OrderSignature[] memory sigs) {
        uint256 id = _id();
        orderCallers.push(msg.sender);
        sigs = new OrderSignature[](descs.length);
        for (uint256 i; i < descs.length; i++) {
            OrderDesc calldata o = descs[i];
            if (!perpetualExists(o.perpId)) revert UnknownPerp();
            PerpetualInfo storage perp = perps[o.perpId];
            PositionInfo storage p = positions[o.perpId][id];
            uint256 mark = perp.markPNS;
            bool buy = o.orderType == 0 || o.orderType == 3;
            if (buy ? o.pricePNS < mark : o.pricePNS > mark) continue;
            if (o.orderType <= 1) {
                p.accountId = id;
                p.pricePNS = (p.pricePNS * p.lotLNS + o.pricePNS * o.lotLNS) / (p.lotLNS + o.lotLNS);
                p.lotLNS += o.lotLNS;
                p.positionType = o.orderType;
                p.depositCNS += (o.pricePNS * o.lotLNS * 1e6 * 100) / (10 ** perp.priceDecimals * 10 ** perp.lotDecimals * o.leverageHdths);
            } else {
                if (o.lotLNS > p.lotLNS) revert TooMuch();
                int256 diff = int256(o.pricePNS) - int256(p.pricePNS);
                if (p.positionType == 1) diff = -diff;
                int256 pnl = (diff * int256(o.lotLNS) * 1e6) / int256(10 ** perp.priceDecimals * 10 ** perp.lotDecimals);
                accounts[id].balanceCNS = uint256(int256(accounts[id].balanceCNS) + pnl);
                p.depositCNS -= (p.depositCNS * o.lotLNS) / p.lotLNS;
                p.lotLNS -= o.lotLNS;
                if (p.lotLNS == 0) delete positions[o.perpId][id];
            }
            sigs[i] = OrderSignature(o.perpId, ++lastId);
        }
    }

    function _id() internal view returns (uint256 id) {
        id = idOf[msg.sender];
        if (id == 0) revert NoAccount(msg.sender);
    }
}

/// The desk: owned by the Treasury, traded by its operators. Operators may only call execOrders;
/// withdrawing is the owner's alone and always pays the owner.
contract DelegatedAccountStub {
    bytes32 internal constant BEACON_SLOT = 0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50;
    bytes32 internal constant ASSIGN_TYPEHASH = keccak256("AssignOperator(address owner,uint256 nonce,uint256 deadline)");

    address public immutable owner;
    address public immutable exchange;
    uint256 public accountId;
    mapping(address => bool) public isOperator;
    mapping(address => uint256) public operatorNonces;

    error NotOwner();
    error NotOperator();
    error BadSignature();
    error Expired();

    event OperatorAdded(address indexed operator);
    event OperatorRemoved(address indexed operator);

    constructor(address _owner, address _exchange, address _operator, address _beacon, address token) {
        owner = _owner;
        exchange = _exchange;
        isOperator[_operator] = true;
        assembly { sstore(BEACON_SLOT, _beacon) }
        IToken(token).approve(_exchange, type(uint256).max);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function addOperator(address op, uint256 deadline, bytes calldata sig) external onlyOwner {
        if (deadline < block.timestamp) revert Expired();
        bytes32 domain = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("DelegatedAccount"), keccak256("1"), block.chainid, address(this)));
        if (_recover(domain, keccak256(abi.encode(ASSIGN_TYPEHASH, owner, operatorNonces[op]++, deadline)), sig) != op) revert BadSignature();
        isOperator[op] = true;
        emit OperatorAdded(op);
    }
    function removeOperator(address op) external onlyOwner {
        isOperator[op] = false;
        emit OperatorRemoved(op);
    }
    function resignOperator() external {
        if (!isOperator[msg.sender]) revert NotOperator();
        isOperator[msg.sender] = false;
        emit OperatorRemoved(msg.sender);
    }
    function createAccount(uint256 amount) external onlyOwner {
        accountId = ExchangeStub(exchange).createAccount(amount);
    }
    function withdrawCollateral(uint256 amount) external onlyOwner {
        ExchangeStub(exchange).withdrawCollateral(amount);
        IToken(ExchangeStub(exchange).token()).transfer(owner, amount);
    }

    /// The owner may call anything on the exchange through the desk; an operator only execOrders.
    fallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != owner && !(isOperator[msg.sender] && bytes4(data) == ExchangeStub.execOrders.selector)) revert NotOperator();
        (bool ok, bytes memory out) = exchange.call(data);
        if (!ok) assembly { revert(add(out, 32), mload(out)) }
        return out;
    }

    function _recover(bytes32 domain, bytes32 structHash, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        return ecrecover(digest, v, r, s);
    }
}

contract DelegatedAccountFactoryStub {
    bytes32 internal constant ASSIGN_TYPEHASH = keccak256("AssignOperator(address owner,uint256 nonce,uint256 deadline)");
    address public immutable EXCHANGE;
    address public immutable beacon;
    address public immutable token;
    mapping(address => uint256) public operatorNonces;

    error BadSignature();
    error Expired();
    event DelegatedAccountCreated(address indexed proxy, address indexed owner, address indexed operator);

    constructor(address _exchange, address _beacon, address _token) {
        EXCHANGE = _exchange;
        beacon = _beacon;
        token = _token;
    }

    function create(address _operator, uint256 _opDeadline, bytes calldata _opSig) external returns (address proxy) {
        if (_opDeadline < block.timestamp) revert Expired();
        bytes32 domain = keccak256(abi.encode(keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"), keccak256("DelegatedAccountFactory"), keccak256("1"), block.chainid, address(this)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, keccak256(abi.encode(ASSIGN_TYPEHASH, msg.sender, operatorNonces[_operator]++, _opDeadline))));
        if (_opSig.length != 65) revert BadSignature();
        if (ecrecover(digest, uint8(_opSig[64]), bytes32(_opSig[0:32]), bytes32(_opSig[32:64])) != _operator) revert BadSignature();
        proxy = address(new DelegatedAccountStub(msg.sender, EXCHANGE, _operator, beacon, token));
        emit DelegatedAccountCreated(proxy, msg.sender, _operator);
    }
}
