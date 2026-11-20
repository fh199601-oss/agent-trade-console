// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPair, IFactory, IWrapped} from "./ResearchExecutor.sol";

/// @notice Holder-authorized, multi-token Pancake V2 executor.
/// @dev No owner/admin, arbitrary calls, adjustable recipients, or upgrade hooks.
/// The application must separately verify the declaration source is canonical,
/// non-upgradeable and associated with this token. A factory match is not proof.
contract FastSaleExecutor is ReentrancyGuard {
    using SafeERC20 for IERC20;
    uint256 public constant MAX_BATCH = 64;
    uint256 public constant ITEM_GAS = 500_000;
    address public immutable factory;
    bytes32 public immutable factoryHash;
    bytes32 public immutable pairHash;
    address public immutable wrapped;
    bytes32 public immutable wrappedHash;
    struct Venue {
        address token;
        address quote;
        address pair;
        address source;
        bytes4 getter;
        bytes32 tokenHash;
        bytes32 quoteHash;
        bytes32 sourceHash;
    }
    enum State { Missing, Active, Filled, Cancelled }
    struct Plan {
        address owner;
        address trigger;
        bytes32 venue;
        uint112 cap;
        uint128 minOut;
        uint48 deadline;
        State state;
        bool paused;
        bool nativeOutput;
    }
    mapping(bytes32 => Venue) public venues;
    mapping(bytes32 => Plan) public plans;
    mapping(bytes32 => uint8) public sellPercent;
    mapping(address => uint256) public nonces;
    mapping(address => mapping(address => bytes32)) public active;
    error WrongChain(); error InvalidPlan(); error WrongPrimary();
    error NotOwner(); error NotActive(); error WrongTrigger(); error Expired();
    error Paused(); error EmptyBalance(); error AllowanceLow(); error MinimumNotMet();
    error OpeningUnknown(); error MarketClosed(); error HighTransferFee(); error UnsupportedTransfer(); error OnlySelf(); error BadBatch(); error ItemError();
    event Registered(bytes32 indexed id, address indexed owner, address token, uint256 cap, uint256 deadline);
    event Sold(bytes32 indexed id, address indexed owner, uint256 amount, uint256 output, bool nativePaid);
    event ItemFailed(bytes32 indexed id, bytes4 reason);
    event BatchDeferred(uint256 nextIndex);
    event Controlled(bytes32 indexed id, State state, bool paused);
    constructor(address f, bytes32 expectedFactoryHash, bytes32 expectedPairHash, address w) {
        if (block.chainid != 31337 && block.chainid != 56) revert WrongChain();
        if (block.chainid == 56 && (f != 0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73 || w != 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c ||
            expectedPairHash != address(0x58F876857a02D6762E0101bb5C46A8c1ED44Dc16).codehash)) revert WrongPrimary();
        if (f.code.length == 0 || f.codehash != expectedFactoryHash || expectedPairHash == bytes32(0) || w.code.length == 0) revert WrongPrimary();
        factory=f; factoryHash=expectedFactoryHash; pairHash=expectedPairHash;
        wrapped=w; wrappedHash=w.codehash;
    }
    // Holder submits the exact bounded plan. Token approval alone cannot sell.
    function registerPlan(Venue calldata v, uint112 cap, uint128 minOut, address trigger, bool nativeOutput) external nonReentrant returns(bytes32 id) {
        return register(v,cap,minOut,trigger,nativeOutput,100,48);
    }
    function registerSale(Venue calldata v, uint112 cap, uint128 minOut, address trigger, bool nativeOutput, uint8 percent, uint8 hoursValid) external nonReentrant returns(bytes32) {
        return register(v,cap,minOut,trigger,nativeOutput,percent,hoursValid);
    }
    function register(Venue calldata v, uint112 cap, uint128 minOut, address trigger, bool nativeOutput, uint8 percent, uint8 hoursValid) private returns(bytes32 id) {
        if ((percent==0 || percent>100) || hoursValid==0 || hoursValid>48) revert InvalidPlan();
        if(cap==0 || minOut==0 || trigger==address(0) || (nativeOutput && v.quote!=wrapped)) revert InvalidPlan();
        Plan storage old=plans[active[msg.sender][v.token]];
        if(old.state==State.Active && block.timestamp<=old.deadline) {
            if(!canReplace(active[msg.sender][v.token],v)) revert NotActive();
            old.state=State.Cancelled;
            emit Controlled(active[msg.sender][v.token],State.Cancelled,false);
        }
        verify(v, true);
        bytes32 key=keccak256(abi.encode(v)); venues[key]=v;
        id=keccak256(abi.encode(block.chainid,address(this),msg.sender,nonces[msg.sender]++));
        uint48 deadline=uint48(block.timestamp+uint256(hoursValid)*1 hours);
        plans[id]=Plan(msg.sender,trigger,key,cap,minOut,deadline,State.Active,false,nativeOutput);
        active[msg.sender][v.token]=id;
        sellPercent[id]=percent;
        emit Registered(id,msg.sender,v.token,cap,deadline);
    }
    function control(bytes32 id, bool paused, bool cancel) external nonReentrant {
        Plan storage p=plans[id];
        if(msg.sender!=p.owner) revert NotOwner();
        if(p.state!=State.Active) revert NotActive();
        p.paused=paused; if(cancel) p.state=State.Cancelled;
        emit Controlled(id,p.state,p.paused);
    }
    // Ignore absent getters. Fallback contracts returning a word for arbitrary
    // selectors cannot supply positive opening evidence.
    function word(address target, bytes4 selector) private view returns(bool ok,uint256 value) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr,selector)
            ok := staticcall(18000,target,ptr,4,ptr,32)
            ok := and(ok,eq(returndatasize(),32))
            value := mload(ptr)
        }
    }
    function openingState(address token,address source) public view returns(bool known,bool opened) {
        bytes4[5] memory flags=[bytes4(keccak256("trading()")),bytes4(keccak256("tradingOpen()")),
            bytes4(keccak256("tradingEnabled()")),bytes4(keccak256("openBlock()")),bytes4(keccak256("tradingStartBlock()"))];
        bytes4[3] memory completion=[bytes4(keccak256("mintComplete()")),bytes4(keccak256("mintCompleted()")),bytes4(keccak256("mintFinished()"))];
        for(uint256 n; n<(source==token?1:2); ++n) {
            address target=n==0?token:source;
            (bool fallbackWord,)=word(target,0x13579bdf);
            if(fallbackWord)continue;
            for(uint256 k; k<completion.length; ++k){
                (bool ok,uint256 done)=word(target,completion[k]);
                if(ok&&done!=1)return (true,false);
            }
            for(uint256 i; i<flags.length; ++i) {
                (bool ok,uint256 value)=word(target,flags[i]);
                if(!ok)continue;
                known=true;
                if(i<3 ? value!=1 : value==0||value>block.number)return (true,false);
            }
        }
        return (known,known);
    }
    function canonicalBeforeOpening(Venue memory v) private view returns(bool) {
        // Only an issuer-bound factory and quote can commit a pair before
        // opening. A third party can create or dust any factory pair.
        (bool ok,uint256 quote)=word(v.source,bytes4(keccak256("wrappedNative()")));
        if(!ok)(ok,quote)=word(v.source,bytes4(keccak256("WBNB()")));
        if(!ok||quote!=uint160(v.quote))return false;
        (bool hasFactory,uint256 f)=word(v.source,bytes4(keccak256("factory()")));
        if(!hasFactory){
            (ok,f)=word(v.source,bytes4(keccak256("router()")));
            if(!ok||f>type(uint160).max)return false;
            (hasFactory,f)=word(address(uint160(f)),bytes4(keccak256("factory()")));
        }
        // verify() also checks factory.getPair or the exact CREATE2 address
        // for a pair the authenticated factory has not created yet.
        return hasFactory&&f==uint160(factory);
    }
    function canReplace(bytes32 id,Venue memory next) public view returns(bool) {
        Venue memory old=venues[plans[id].venue];
        if(old.pair==address(0)||old.pair==next.pair||old.source!=next.source||old.token!=next.token)return false;
        (bool ok,uint256 current)=word(old.source,old.getter);
        if(!ok||current!=uint160(next.pair))return false;
        verify(next,false);
        return true;
    }
    function checkDeclarations(Venue memory v) private view {
        bytes4[4] memory names=[bytes4(keccak256("pair()")),bytes4(keccak256("pancakePair()")),bytes4(keccak256("uniswapV2Pair()")),bytes4(keccak256("lpPair()"))];
        for(uint256 n; n<(v.source==v.token?1:2); ++n){
            address target=n==0?v.source:v.token;
            for(uint256 i; i<names.length; ++i){
                if(n==0&&names[i]==v.getter)continue;
                (bool ok,uint256 value)=word(target,names[i]);
                if(ok&&value!=0&&value!=uint160(v.pair))revert WrongPrimary();
            }
        }
    }
    function verify(Venue memory v, bool preparing) public view returns(bool token0) {
        if(v.token==v.quote || v.token.code.length==0 || v.quote.code.length==0 || v.source.code.length==0 ||
           v.token.codehash!=v.tokenHash || v.quote.codehash!=v.quoteHash || v.source.codehash!=v.sourceHash ||
           factory.codehash!=factoryHash || v.pair==address(0) || wrapped.codehash!=wrappedHash) revert WrongPrimary();
        if(v.getter!=bytes4(keccak256("pair()")) && v.getter!=bytes4(keccak256("pancakePair()")) &&
           v.getter!=bytes4(keccak256("uniswapV2Pair()")) && v.getter!=bytes4(keccak256("lpPair()"))) revert WrongPrimary();
        (bool ok,bytes memory result)=v.source.staticcall(abi.encodeWithSelector(v.getter));
        if(!ok || result.length!=32) revert WrongPrimary();
        address declared=abi.decode(result,(address));
        (bool known,bool opened)=openingState(v.token,v.source);
        if(!known)revert OpeningUnknown();
        if(!opened){
            if(!preparing)revert MarketClosed();
            if(!canonicalBeforeOpening(v))revert WrongPrimary();
        }else{
            if(declared!=v.pair)revert WrongPrimary();
            // Where the issuing sale publishes its canonical factory and quote,
            // also verify them after mint closes, including the first sale block.
            if(v.source!=v.token){
                (bool hasQuote,)=word(v.source,bytes4(keccak256("wrappedNative()")));
                (bool hasFactory,)=word(v.source,bytes4(keccak256("factory()")));
                if(hasQuote&&hasFactory&&!canonicalBeforeOpening(v))revert WrongPrimary();
            }
            checkDeclarations(v);
        }
        if(block.chainid==56 && v.source==v.token) {
            (bool hasSale,uint256 sale)=word(v.token,bytes4(keccak256("sale()")));
            if(hasSale&&sale!=0&&sale<=type(uint160).max){
                (bool hasToken,uint256 saleToken)=word(address(uint160(sale)),bytes4(keccak256("token()")));
                if(hasToken&&saleToken==uint160(v.token))revert WrongPrimary();
            }
        }
        if(v.source!=v.token) {
            (ok,result)=v.source.staticcall(abi.encodeWithSignature("token()"));
            if(!ok || result.length!=32 || abi.decode(result,(address))!=v.token) revert WrongPrimary();
        }
        if(block.chainid==56 && v.source!=v.token) {
            (ok,result)=v.token.staticcall(abi.encodeWithSignature("sale()"));
            if(!ok || result.length!=32 || abi.decode(result,(address))!=v.source) revert WrongPrimary();
        }
        address actual=IFactory(factory).getPair(v.token,v.quote);
        if(preparing && !opened && actual==address(0) && v.pair.code.length==0) {
            (ok,result)=factory.staticcall(abi.encodeWithSignature("INIT_CODE_PAIR_HASH()"));
            if(!ok || result.length!=32) revert WrongPrimary();
            (address lo,address hi)=v.token<v.quote?(v.token,v.quote):(v.quote,v.token);
            bytes32 digest=keccak256(abi.encodePacked(hex"ff",factory,keccak256(abi.encodePacked(lo,hi)),abi.decode(result,(bytes32))));
            if(address(uint160(uint256(digest)))!=v.pair) revert WrongPrimary();
            return lo==v.token;
        }
        if(actual!=v.pair || v.pair.codehash!=pairHash || IPair(v.pair).factory()!=factory) revert WrongPrimary();
        token0=IPair(v.pair).token0()==v.token;
        if(token0 ? IPair(v.pair).token1()!=v.quote : (IPair(v.pair).token0()!=v.quote || IPair(v.pair).token1()!=v.token)) revert WrongPrimary();
    }
    function executeBatch(bytes32[] calldata ids) external nonReentrant {
        if(ids.length==0 || ids.length>MAX_BATCH) revert BadBatch();
        for(uint256 i; i<ids.length; ++i) {
            if(gasleft()<ITEM_GAS+ITEM_GAS/63+60_000) {emit BatchDeferred(i); break;}
            bytes memory input=abi.encodeCall(this.executeOne,(ids[i],msg.sender));
            bool ok; bytes4 reason;
            assembly ("memory-safe") {
                ok:=call(ITEM_GAS,address(),0,add(input,32),mload(input),0,0)
                if iszero(ok) {if gt(returndatasize(),3) {returndatacopy(0,0,4) reason:=mload(0)}}
            }
            if(!ok) emit ItemFailed(ids[i],reason==bytes4(0)?ItemError.selector:reason);
        }
    }
    function executeOne(bytes32 id,address caller) external {
        if(msg.sender!=address(this) || !_reentrancyGuardEntered()) revert OnlySelf();
        Plan storage p=plans[id];
        if(p.state!=State.Active) revert NotActive();
        if(p.paused) revert Paused();
        if(caller!=p.trigger) revert WrongTrigger();
        if(block.timestamp>p.deadline) revert Expired();
        Venue memory v=venues[p.venue]; bool token0=verify(v,false);
        IERC20 token=IERC20(v.token); IERC20 quote=IERC20(v.quote);
        uint256 amount=token.balanceOf(p.owner); if(amount>p.cap) amount=p.cap;
        amount=amount*sellPercent[id]/100;
        if(amount==0) revert EmptyBalance();
        if(token.allowance(p.owner,address(this))<amount) revert AllowanceLow();
        p.state=State.Filled;
        uint256 credited = fundPair(v, p.owner, amount, token0);
        uint256 output = swapNet(v, token0, credited, amount, p.nativeOutput ? address(this) : p.owner, p.minOut);
        bool nativePaid;
        if(p.nativeOutput) {
            IWrapped(wrapped).withdraw(output); address owner=p.owner;
            assembly ("memory-safe") {nativePaid:=call(50000,owner,output,0,0,0,0)}
            // Explicit native-output policy includes same-owner WBNB fallback.
            if(!nativePaid) {
                uint256 beforeOwner=quote.balanceOf(owner);
                IWrapped(wrapped).deposit{value:output}(); quote.safeTransfer(owner,output);
                if(quote.balanceOf(owner)!=beforeOwner+output) revert UnsupportedTransfer();
            }
        }
        emit Sold(id,p.owner,amount,output,nativePaid);
    }
    function reserves(Venue memory v, bool token0) private view returns(uint256 rin, uint256 rout) {
        (uint112 r0,uint112 r1,)=IPair(v.pair).getReserves();
        return token0 ? (r0,r1) : (r1,r0);
    }
    function fundPair(Venue memory v,address owner,uint256 amount,bool token0) private returns(uint256 credited) {
        IERC20 token=IERC20(v.token);
        (uint256 priorReserve,)=reserves(v,token0);
        uint256 beforePair=token.balanceOf(v.pair);
        if(beforePair<priorReserve) revert UnsupportedTransfer();
        uint256 priorSurplus=beforePair-priorReserve;
        uint256 beforeOwner=token.balanceOf(owner);
        token.safeTransferFrom(owner,v.pair,amount);
        uint256 afterOwner=token.balanceOf(owner);
        if(afterOwner>beforeOwner || beforeOwner-afterOwner!=amount) revert UnsupportedTransfer();
        // A tax token can swap back and sync this pair inside transferFrom.
        // Attribute only new, unaccounted input, excluding pre-existing donations.
        (uint256 rin,)=reserves(v,token0);
        uint256 balance=token.balanceOf(v.pair);
        if(balance<rin || balance-rin<priorSurplus) revert UnsupportedTransfer();
        credited=balance-rin-priorSurplus;
        if(credited>amount) revert UnsupportedTransfer();
        if(credited==0) revert HighTransferFee();
    }
    function swapNet(Venue memory v,bool token0,uint256 input,uint256 amount,address recipient,uint256 minimum) private returns(uint256 net) {
        (uint256 rin,uint256 rout)=reserves(v,token0);
        uint256 gross=input*9975*rout/(rin*10000+input*9975);
        if(gross==0 || gross<minimum) revert MinimumNotMet();
        IERC20 quote=IERC20(v.quote);
        uint256 beforeOut=quote.balanceOf(recipient);
        IPair(v.pair).swap(token0?0:gross,token0?gross:0,recipient,"");
        uint256 afterOut=quote.balanceOf(recipient);
        if(afterOut<beforeOut || afterOut-beforeOut>gross) revert UnsupportedTransfer();
        net=afterOut-beforeOut;
        // Combine both transfer legs and the pinned pool fee. Cross-products fit
        // in 256 bits (amount and pool reserves are at most 112 bits).
        if(input*net*9975 <= amount*gross*5000) revert HighTransferFee();
        if(net<minimum) revert MinimumNotMet();
    }
    receive() external payable {if(msg.sender!=wrapped || !_reentrancyGuardEntered()) revert OnlySelf();}
}
