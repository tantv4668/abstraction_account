import { utils, Wallet, Provider, EIP712Signer, types } from "zksync-web3";
import * as ethers from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { Deployer } from "@matterlabs/hardhat-zksync-deploy";

// Put the address of your AA factory
const AA_FACTORY_ADDRESS = "0xa7De74740346a83db08E2c73D24285c6A5E33a61";

export default async function (hre: HardhatRuntimeEnvironment) {
  const provider = new Provider("https://testnet.era.zksync.dev");
  // Private key of the account used to deploy AA account
  const deployerWallet = new Wallet("<PRIVATE_KEY>").connect(provider);

  const deployer = new Deployer(hre, deployerWallet);

  const factoryArtifact = await hre.artifacts.readArtifact("AAFactory");
  const busdArtifact = await deployer.loadArtifact("MockBUSD");

  const aaFactory = new ethers.Contract(
    AA_FACTORY_ADDRESS,
    factoryArtifact.abi,
    deployerWallet
  );

  const busd = await deployer.deploy(busdArtifact, ["BUSD", "BUSD"], undefined); // chỗ này dùng deployerWallet để deploy BUSD nên owner của BUSD đang là deployerWallet

  // The two owners of the multisig, chỗ này tạo 2 ví owner random để test
  const owner1 = Wallet.createRandom();
  const owner2 = Wallet.createRandom();

  // For the simplicity of the tutorial, we will use zero hash as salt
  const salt = ethers.constants.HashZero; // chõ này salt đang là 0 do chỉ chạy 1 lần, chạy thực tế cần phải random salt

  // deploy AA account owned by owner1 & owner2
  const tx = await aaFactory.deployAccount(
    salt,
    owner1.address,
    owner2.address
  );
  await tx.wait();

  // Getting the address of the deployed contract account
  const abiCoder = new ethers.utils.AbiCoder();
  // multisigAddress là AA address
  const multisigAddress = utils.create2Address(
    AA_FACTORY_ADDRESS,
    await aaFactory.aaBytecodeHash(),
    salt,
    abiCoder.encode(["address", "address"], [owner1.address, owner2.address])
  );
  console.log(`Multisig account deployed on address ${multisigAddress}`);

  // Gửi ETH từ deployerWallet đến AA để làm gas
  console.log("Sending funds to multisig account");
  // Send funds to the multisig account we just deployed
  await (
    await deployerWallet.sendTransaction({
      to: multisigAddress,
      // You can increase the amount of ETH sent to the multisig
      value: ethers.utils.parseEther("0.02"),
    })
  ).wait();

  let multisigBalance = await provider.getBalance(multisigAddress);

  console.log(`Multisig account balance is ${multisigBalance.toString()}`);

  // Checking that the nonce for the account has increased
  console.log(
    `The multisig's nonce before the mint tx is ${await provider.getTransactionCount(
      multisigAddress
    )}`
  );

  // để xuất mint tx bằng deployerWallet
  let mintTx = await busd.populateTransaction.mint(
    multisigAddress,
    "1000000000000000"
  );

  // do chỗ này BUSD owner đang là deployerWallet nên không cần gán lại trường from mà estimate luôn

  const gasLimitMintTx = await provider.estimateGas(mintTx);
  const gasPriceMinTx = await provider.getGasPrice();

  // gán lại các thông tin cho mintTx
  mintTx = {
    ...mintTx,
    from: multisigAddress,
    gasLimit: gasLimitMintTx,
    gasPrice: gasPriceMinTx,
    chainId: (await provider.getNetwork()).chainId,
    nonce: await provider.getTransactionCount(multisigAddress),
    type: 113,
    customData: {
      gasPerPubdata: utils.DEFAULT_GAS_PER_PUBDATA_LIMIT,
    } as types.Eip712Meta,
    value: ethers.BigNumber.from(0),
  };

  console.log("Mint tx: ", mintTx);

  const signedMintTxHash = EIP712Signer.getSignedDigest(mintTx);

  console.log(signedMintTxHash);

  const owner1Signature = ethers.utils.joinSignature(
    owner1._signingKey().signDigest(signedMintTxHash)
  );

  const owner2Signature = ethers.utils.joinSignature(
    owner2._signingKey().signDigest(signedMintTxHash)
  );

  const signatureMint = ethers.utils.concat([
    // Note, that `signMessage` wouldn't work here, since we don't want
    // the signed hash to be prefixed with `\x19Ethereum Signed Message:\n`
    owner1Signature,
    owner2Signature,
  ]);

  mintTx.customData = {
    ...mintTx.customData,
    customSignature: signatureMint,
  };

  // do BUSD owner vẫn đang là deployerWallet nên cần phải transferOwnership() cho AA thì AA mới có quyền mint()
  const transferOwnershipTx = await busd.transferOwnership(multisigAddress);
  await transferOwnershipTx.wait();

  // transferOwnership() xong thì gửi tx đã được ký để mint()
  const sentMintTx = await provider.sendTransaction(utils.serialize(mintTx));
  await sentMintTx.wait();

  console.log(
    `The multisig's nonce after the mint tx is ${await provider.getTransactionCount(
      multisigAddress
    )}`
  );

  multisigBalance = await provider.getBalance(multisigAddress);

  // log chỗ này ra để thấy ETH của AA đã giảm, chứng tỏ gas của mintTx là do AA chịu chứ ko phải owner1 hay owner2
  console.log(
    `Multisig account balance is now ${multisigBalance.toString()} ETH`
  );

  // get BUSD balance của AA ra để thấy mint() đã thành công
  console.log(
    `Multisig account BUSD balance is ${await busd.balanceOf(multisigAddress)}`
  );
}
