关于传输链路方面的技术难题

分支：dev-2607B-NEWCODE-DEBUG
版本：0b8e4e18b84a035586a17977de76c7c701945995
标签：stable-1.7.12
测试日期：260810

目前现状（以同处一个局域网且同一个子网的两设备A/B打开chrome进行几组测试用例说明）：

    测试组A：
        共用信息：
        - trojan-gfw版本1.1.6，igniter版本0.10.3-beta
        - 测试页面：http://10.0.0.11/#ca00b0b9-e226-4eea-9434-7b931bd6b529
        用例编号范围：1 ~ 16
    
        用例1：
            设备A：windows 11, trojan-gfw.exe关闭
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例2：
            设备A：windows 11, trojan-gfw.exe关闭
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以socket.io relay，期望全部以P2P
        
        用例3：
            设备A：windows 11, trojan-gfw.exe关闭
            设备B：android 10, igniter启用且禁用[Exempt Chinese Domain/IPs]
            传输表现：无法打开页面，不需期望
        
        用例4：
            设备A：windows 11, trojan-gfw.exe开启且走PAC模式
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例5：
            设备A：windows 11, trojan-gfw.exe开启且走PAC模式
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以socket.io relay，期望全部以P2P
        
        用例6：
            设备A：windows 11, trojan-gfw.exe开启且走PAC模式
            设备B：android 10, igniter启用且禁用[Exempt Chinese Domain/IPs]
            传输表现：无法打开页面，不需期望
        
        用例7：
            设备A：windows 11, trojan-gfw.exe开启且走全局模式
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
            
        用例8：
            设备A：windows 11, trojan-gfw.exe开启且走全局模式
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以socket.io relay，期望全部以P2P
        
        用例9：
            设备A：windows 11, trojan-gfw.exe开启且走全局模式
            设备B：android 10, igniter启用且禁用[Exempt Chinese Domain/IPs]
            传输表现：无法打开页面，不需期望
        
        用例10：
            设备A：windows 11, trojan-gfw.exe开启且走增强模式
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例11：
            设备A：windows 11, trojan-gfw.exe开启且走增强模式
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以socket.io relay，期望全部以P2P
        
        用例12：
            设备A：windows 11, trojan-gfw.exe开启且走增强模式
            设备B：android 10, igniter启用且禁用[Exempt Chinese Domain/IPs]
            传输表现：无法打开页面，不需期望
        
        用例13：
            设备A：android 13, igniter关闭
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例14：
            设备A：android 13, igniter关闭
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以P2P，如期望
        
        用例15：
            设备A：android 13, igniter启用且启用[Exempt Chinese Domain/IPs]
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例16：
            设备A：android 13, igniter启用且启用[Exempt Chinese Domain/IPs]
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以socket.io relay，期望全部以P2P

    测试组B：
        共用信息：
        - trojan-gfw版本1.1.6，igniter版本0.10.3-beta
        - 测试页面：https://tun-test.miku.us/#6732a50e-120c-4d77-a12f-bcf5a8952e27
        用例编号范围：17 ~ 32
    
        用例17：
            设备A：windows 11, trojan-gfw.exe关闭
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例18：
            设备A：windows 11, trojan-gfw.exe关闭
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以socket.io relay，期望全部以P2P
        
        用例19：
            设备A：windows 11, trojan-gfw.exe关闭
            设备B：android 10, igniter启用且禁用[Exempt Chinese Domain/IPs]
            传输表现：无法打开页面，不需期望
        
        用例20：
            设备A：windows 11, trojan-gfw.exe开启且走PAC模式
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例21：
            设备A：windows 11, trojan-gfw.exe开启且走PAC模式
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以socket.io relay，期望全部以P2P
        
        用例22：
            设备A：windows 11, trojan-gfw.exe开启且走PAC模式
            设备B：android 10, igniter启用且禁用[Exempt Chinese Domain/IPs]
            传输表现：无法打开页面，不需期望
        
        用例23：
            设备A：windows 11, trojan-gfw.exe开启且走全局模式
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
            
        用例24：
            设备A：windows 11, trojan-gfw.exe开启且走全局模式
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以socket.io relay，期望全部以P2P
        
        用例25：
            设备A：windows 11, trojan-gfw.exe开启且走全局模式
            设备B：android 10, igniter启用且禁用[Exempt Chinese Domain/IPs]
            传输表现：无法打开页面，不需期望
        
        用例26：
            设备A：windows 11, trojan-gfw.exe开启且走增强模式
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例27：
            设备A：windows 11, trojan-gfw.exe开启且走增强模式
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以socket.io relay，期望全部以P2P
        
        用例28：
            设备A：windows 11, trojan-gfw.exe开启且走增强模式
            设备B：android 10, igniter启用且禁用[Exempt Chinese Domain/IPs]
            传输表现：无法打开页面，不需期望
        
        用例29：
            设备A：android 13, igniter关闭
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例30：
            设备A：android 13, igniter关闭
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以P2P，如期望
        
        用例31：
            设备A：android 13, igniter启用且启用[Exempt Chinese Domain/IPs]
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例32：
            设备A：android 13, igniter启用且启用[Exempt Chinese Domain/IPs]
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以socket.io relay，期望全部以P2P


    测试组C：
        共用信息：
        - trojan-gfw版本1.1.6，igniter版本0.10.3-beta
        - 测试页面：https://tun.miku.us/
        用例编号范围：33 ~ 48
    
        用例33：
            设备A：windows 11, trojan-gfw.exe关闭
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例34：
            设备A：windows 11, trojan-gfw.exe关闭
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以P2P，偶然出现极少socket.io relay，期望全部以P2P（不用太在意这个偶然。可以解释为网络波动后出现socket.io relay进度条，之后全是P2P）
        
        用例35：
            设备A：windows 11, trojan-gfw.exe关闭
            设备B：android 10, igniter启用且禁用[Exempt Chinese Domain/IPs]
            传输表现：无法打开页面，不需期望
        
        用例36：
            设备A：windows 11, trojan-gfw.exe开启且走PAC模式
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例37：
            设备A：windows 11, trojan-gfw.exe开启且走PAC模式
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以P2P，如期望 （注意，此用例测试表现在此条件下，在测试环境10.0.0.11和tun-test环境是走socket.io relay）
        
        用例38：
            设备A：windows 11, trojan-gfw.exe开启且走PAC模式
            设备B：android 10, igniter启用且禁用[Exempt Chinese Domain/IPs]
            传输表现：无法打开页面，不需期望
        
        用例39：
            设备A：windows 11, trojan-gfw.exe开启且走全局模式
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
            
        用例40：
            设备A：windows 11, trojan-gfw.exe开启且走全局模式
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以P2P，如期望 （注意，此用例测试表现在此条件下，在测试环境10.0.0.11和tun-test环境是走socket.io relay）
        
        用例41：
            设备A：windows 11, trojan-gfw.exe开启且走全局模式
            设备B：android 10, igniter启用且禁用[Exempt Chinese Domain/IPs]
            传输表现：无法打开页面，不需期望
        
        用例42：
            设备A：windows 11, trojan-gfw.exe开启且走增强模式
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例43：
            设备A：windows 11, trojan-gfw.exe开启且走增强模式
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以P2P，如期望 （注意，此用例测试表现在此条件下，在测试环境10.0.0.11和tun-test环境是走socket.io relay）
        
        用例44：
            设备A：windows 11, trojan-gfw.exe开启且走增强模式
            设备B：android 10, igniter启用且禁用[Exempt Chinese Domain/IPs]
            传输表现：无法打开页面，不需期望
        
        用例45：
            设备A：android 13, igniter关闭
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例46：
            设备A：android 13, igniter关闭
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以P2P，如期望
        
        用例47：
            设备A：android 13, igniter启用且启用[Exempt Chinese Domain/IPs]
            设备B：android 10, igniter关闭
            传输表现：全部以P2P，如期望
        
        用例48：
            设备A：android 13, igniter启用且启用[Exempt Chinese Domain/IPs]
            设备B：android 10, igniter启用且启用[Exempt Chinese Domain/IPs]
            传输表现：全部以P2P，如期望 （注意，此用例测试表现在此条件下，在测试环境10.0.0.11和tun-test环境是走socket.io relay）

    
总结：

从用例1~12、17~28来看，windows设备A不论有没有开启代理或代理开什么模式，都不影响测试表现，而取决于android设备B。
从用例13~16、29~32来看，两台相似环境都使用igniter的android设备，只要不全部都启用igniter且启用[Exempt Chinese Domain/IPs]，那么就可以走P2P。
用例33~44的测试表现，跟相似条件的用例1~12、17~28的测试表现不完全一致，差异在于在tun.miku.us正式环境下，windows设备A和android设备B都启用网络代理时可走P2P。
用例46~48的测试表现，跟相似条件的用例13~16、29~32的测试表现不完全一致，差异在于在tun.miku.us正式环境下，android设备A和android设备B都启用网络代理时可走P2P。