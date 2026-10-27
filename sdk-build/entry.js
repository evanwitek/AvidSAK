// Bundle entry: exposes the PanelSDK gRPC-web classes this panel uses as window.McapiSdk.
var Types = require('./grpc-web/MCAPI_Types_pb.js');
var Client = require('./grpc-web/MCAPI_grpc_web_pb.js');

window.McapiSdk = {
  MCAPIClient: Client.MCAPIClient,
  CreateBinRequest: Types.CreateBinRequest,
  CreateBinRequestBody: Types.CreateBinRequestBody,
  LinkFileRequest: Types.LinkFileRequest,
  LinkFileRequestBody: Types.LinkFileRequestBody,
  OpenBinRequest: Types.OpenBinRequest,
  OpenBinRequestBody: Types.OpenBinRequestBody,
  GetBinInfoRequest: Types.GetBinInfoRequest,
  GetBinInfoRequestBody: Types.GetBinInfoRequestBody,
  GetBinsRequest: Types.GetBinsRequest,
  GetBinsRequestBody: Types.GetBinsRequestBody,
  GetListOfLinkSettingsRequest: Types.GetListOfLinkSettingsRequest,
  GetListOfLinkSettingsRequestBody: Types.GetListOfLinkSettingsRequestBody
};
